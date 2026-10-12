import "server-only";
import { decodeEventLog, decodeFunctionData, encodeFunctionData, getAddress, parseAbi, TransactionReceiptNotFoundError, type Address, type Hex, type TransactionReceipt } from "viem";
import { getPaymentNonce, normalizeAddress, toContractPayment, verifyPaymentSignature, type ChainContext } from "../db/authorization";
import { createPaymentRepository, type PaymentRecord } from "../db/payments";
import { prepaidAbi } from "../prepaid";
import { arcClient } from "../server/config";
import { ApiError } from "../server/http";
import type { RelayerBatch, RelayerCandidate, RelayerResult } from "./types";

const usdcAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function authorizationState(address,bytes32) view returns (bool)"]);
export const rewardFor = (tip: string) => BigInt(tip) * BigInt(70) / BigInt(100);
type Repository = ReturnType<typeof createPaymentRepository>;
type Client = ReturnType<typeof arcClient>;

export async function checkPayments(rows: PaymentRecord[], context: ChainContext, client: Client) {
  const block = await client.getBlock();
  const budgets = new Map<string, bigint>();
  const checked: { row: PaymentRecord; reason: string | null }[] = [];
  for (const row of rows) {
    let reason: string | null = null;
    if (BigInt(row.validAfter) >= block.timestamp || BigInt(row.validBefore) <= block.timestamp) reason = "Outside its payment window";
    else {
      const [cancelled, used, balance] = await Promise.all([
        client.readContract({ address: context.prepaid, abi: prepaidAbi, functionName: "cancelledSchedules", args: [row.payer, row.scheduleId] }),
        client.readContract({ address: context.usdc, abi: usdcAbi, functionName: "authorizationState", args: [row.payer, row.nonce] }),
        budgets.has(row.payer) ? Promise.resolve(budgets.get(row.payer)!) : client.readContract({ address: context.usdc, abi: usdcAbi, functionName: "balanceOf", args: [row.payer] }),
      ]);
      const cost = BigInt(row.amount) + BigInt(row.tip);
      if (cancelled) reason = "Schedule cancelled";
      else if (used) reason = "Authorization already used or revoked";
      else if (balance < cost) reason = "Payer balance cannot cover this batch";
      else {
        await verifyPaymentSignature(row, row);
        budgets.set(row.payer, balance - cost);
      }
    }
    checked.push({ row, reason });
  }
  return checked;
}

export async function discover(context: ChainContext, repo: Repository, client: Client): Promise<RelayerCandidate[]> {
  const block = await client.getBlock();
  await repo.expirePayments(context, block.timestamp.toString());
  const rows = await repo.listDuePayments(context, block.timestamp.toString(), 50);
  const checked = await checkPayments(rows, context, client);
  // Used/revoked authorizations cannot become executable again. Preserve any known
  // execution first; otherwise mark availability honestly without inventing a payment receipt.
  for (const { row, reason } of checked) {
    if (reason !== "Authorization already used or revoked") continue;
    const latest = await client.getBlockNumber();
    const logs = await client.getLogs({ address: context.prepaid,
      event: prepaidAbi.find((item) => item.type === "event" && item.name === "PaymentExecuted")!,
      args: { payer: row.payer, nonce: row.nonce }, fromBlock: latest > BigInt(9998) ? latest - BigInt(9998) : BigInt(0), toBlock: latest, strict: true });
    if (logs[0]?.transactionHash) await reconcile(context, logs[0].transactionHash, repo, client);
    else await repo.recordAuthorizationUnavailable(context, row.payer, row.nonce);
  }
  return checked.map(({ row, reason }) => ({ id: row.id, payer: row.payer, payee: row.payee, amount: row.amount,
    tip: row.tip, validBefore: row.validBefore, reward: rewardFor(row.tip).toString(), eligible: reason === null, reason }));
}

export async function claimBatch(context: ChainContext, executor: Address, count: number, repo: Repository, client: Client): Promise<RelayerBatch> {
  const block = await client.getBlock();
  const claim = await repo.claimDuePayments(context, block.timestamp.toString(), `user:${executor}`, count, 600);
  if (!claim.payments.length) throw new ApiError("No payments are available right now. Refresh and try again.", 409);
  try {
    const checked = await checkPayments(claim.payments, context, client);
    const eligible = checked.filter((p) => !p.reason).map((p) => p.row);
    await repo.releaseClaimPayments(claim.claimToken, checked.filter((p) => p.reason).map((p) => p.row.id), "Payment not currently executable");
    if (!eligible.length) throw new ApiError("These payments cannot execute right now. Refresh to see their current status.", 409);
    const args = [eligible.map((p) => toContractPayment(p, p))] as const;
    const simulated = await client.simulateContract({ address: context.prepaid, abi: prepaidAbi, functionName: "executePayments", args, account: executor });
    if (simulated.result !== BigInt(eligible.length)) throw new ApiError("Some payments failed simulation. No transaction was sent; refresh and retry.", 409);
    const [estimate, fees, balance] = await Promise.all([
      client.estimateContractGas({ address: context.prepaid, abi: prepaidAbi, functionName: "executePayments", args, account: executor }),
      client.estimateFeesPerGas(), client.getBalance({ address: executor }),
    ]);
    const gas = (estimate * BigInt(120) + BigInt(99)) / BigInt(100);
    const maxFeePerGas = fees.maxFeePerGas > BigInt(20000000000) ? fees.maxFeePerGas : BigInt(20000000000);
    const cost = gas * maxFeePerGas;
    const ownPayments = eligible.filter((p) => p.payer === executor).reduce((sum, p) => sum + BigInt(p.amount) + BigInt(p.tip), BigInt(0)) * BigInt(1000000000000);
    if (balance < cost + ownPayments) throw new ApiError("Your wallet needs more USDC to cover gas and any payments from your own wallet.", 409);
    return { context, claimToken: claim.claimToken, ids: eligible.map((p) => p.id),
      payments: eligible.map((p) => ({ payer: p.payer, scheduleId: p.scheduleId, payee: p.payee, amount: p.amount, tip: p.tip,
        validAfter: p.validAfter, validBefore: p.validBefore, salt: p.salt, v: p.v, r: p.r, s: p.s })),
      reward: eligible.reduce((total, p) => total + rewardFor(p.tip), BigInt(0)).toString(), gas: gas.toString(),
      maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), estimatedCost: cost.toString(),
      expiresAt: eligible[0].leaseUntil!.toISOString() };
  } catch (error) { await repo.releaseClaims(claim.claimToken, "Batch preparation failed"); throw error; }
}

export function executionEvents(receipt: TransactionReceipt, context: ChainContext) {
  return receipt.logs.flatMap((log) => {
    if (log.removed || log.address.toLowerCase() !== context.prepaid) return [];
    try {
      const event = decodeEventLog({ abi: prepaidAbi, topics: log.topics, data: log.data, strict: true });
      return event.eventName === "PaymentExecuted" || event.eventName === "PaymentFailed" ? [event] : [];
    } catch { return []; }
  });
}

/** Verifies the actual transaction's calldata before accepting any browser submission report. */
export async function reconcile(context: ChainContext, hash: Hex, repo: Repository, client: Client,
  executor?: Address, claimToken?: string): Promise<RelayerResult> {
  const tx = await client.getTransaction({ hash });
  if (tx.to?.toLowerCase() !== context.prepaid || (executor && normalizeAddress(tx.from) !== executor) || tx.value !== BigInt(0)) throw new ApiError("This transaction is not your PrePaid batch.");
  const decoded = decodeFunctionData({ abi: prepaidAbi, data: tx.input });
  if (decoded.functionName !== "executePayments") throw new ApiError("Expected a PrePaid batch transaction.");
  const payments = decoded.args[0];
  if (!payments.length || payments.length > 50) throw new ApiError("Invalid transaction batch.");
  const rows = await Promise.all(payments.map(async (p) => {
    const key = { ...context, payer: normalizeAddress(p.payer), scheduleId: p.scheduleId };
    const signature = { ...p, amount: p.amount.toString(), tip: p.tip.toString(), validAfter: p.validAfter.toString(), validBefore: p.validBefore.toString() };
    const row = await repo.getPaymentByNonce(context, key.payer, getPaymentNonce(key, signature));
    if (!row) throw new ApiError("Transaction contains a payment outside this database.");
    return row;
  }));
  const expected = encodeFunctionData({ abi: prepaidAbi, functionName: "executePayments", args: [rows.map((p) => toContractPayment(p, p))] });
  if (expected.toLowerCase() !== tx.input.toLowerCase()) throw new ApiError("Transaction does not match the stored signed payments.");
  for (const oldHash of new Set(rows.filter((p) => p.status === "submitted" && p.transactionHash && p.transactionHash !== hash).map((p) => p.transactionHash!))) {
    const old = await client.getTransaction({ hash: oldHash });
    if (normalizeAddress(old.from) !== normalizeAddress(tx.from) || old.nonce !== tx.nonce) throw new ApiError("Payment belongs to another submitted transaction.", 409);
    await repo.replaceSubmission(context, oldHash, hash, normalizeAddress(tx.from));
  }
  let receipt;
  try { receipt = await client.getTransactionReceipt({ hash }); }
  catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    if (claimToken && executor) {
      const owned = await repo.getRelayerClaim(context, claimToken, executor);
      if (rows.some((row) => !owned.some((p) => p.id === row.id))) throw new ApiError("Batch claim expired or changed. Keep this hash and retry receipt syncing once confirmed.", 409);
      await repo.recordSubmission(rows.map((p) => p.id), claimToken, hash, executor);
    }
    return { pending: true, executed: 0, failed: 0, reward: "0" };
  }
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (receipt.transactionHash !== hash || block.hash !== receipt.blockHash) throw new ApiError("Receipt is not confirmed on this chain.", 409);
  const events = executionEvents(receipt, context);
  let executed = 0, failed = 0, reward = BigInt(0);
  const consumed = new Set<Hex>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const failure = events.some((event) => event.eventName === "PaymentFailed" && event.args.index === BigInt(i)
      && normalizeAddress(event.args.payer) === row.payer && event.args.scheduleId === row.scheduleId);
    const success = !failure && !consumed.has(row.nonce) ? events.find((event) => event.eventName === "PaymentExecuted" && event.args.nonce === row.nonce) : undefined;
    if (receipt.status === "success" && success?.eventName === "PaymentExecuted") {
      const a = success.args;
      if (normalizeAddress(a.payer) !== row.payer || a.scheduleId !== row.scheduleId || normalizeAddress(a.payee) !== row.payee
        || a.amount !== BigInt(row.amount) || a.tip !== BigInt(row.tip) || normalizeAddress(a.executor) !== normalizeAddress(tx.from)
        || a.relayerTip !== rewardFor(row.tip) || a.platformTip !== BigInt(row.tip) - rewardFor(row.tip)) throw new ApiError("Receipt payment instructions do not match.");
      await repo.recordExecution(context, { payer: row.payer, nonce: row.nonce, executor: getAddress(a.executor), transactionHash: hash,
        blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash });
      consumed.add(row.nonce); executed++; reward += a.relayerTip;
    } else {
      if (receipt.status === "success" && !failure) throw new ApiError("Missing per-payment receipt result.");
      // A known confirmed failure is safe to retry. Never release an uncertain transaction.
      if (row.status === "leased" && row.claimToken === claimToken && row.workerId === `user:${normalizeAddress(tx.from)}`) await repo.releaseClaimPayments(row.claimToken, [row.id], "Confirmed transaction or payment failure");
      else if (row.status === "submitted" && row.claimToken && row.transactionHash) await repo.recordSubmissionFailure(row.id, row.claimToken, hash, "Confirmed transaction or payment failure");
      failed++;
    }
  }
  return { pending: false, executed, failed, reward: reward.toString() };
}

/** A confirmed replacement with the same EOA nonce makes the original batch impossible to mine. */
export async function settleReplacement(context: ChainContext, originalHash: Hex, hash: Hex, executor: Address,
  claimToken: string | undefined, repo: Repository, client: Client): Promise<RelayerResult> {
  const [old, replacement, receipt] = await Promise.all([
    client.getTransaction({ hash: originalHash }), client.getTransaction({ hash }), client.getTransactionReceipt({ hash }),
  ]);
  if (hash === originalHash || normalizeAddress(old.from) !== executor || normalizeAddress(replacement.from) !== executor
    || old.nonce !== replacement.nonce || old.to?.toLowerCase() !== context.prepaid) throw new ApiError("This is not a replacement of your batch.");
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (receipt.transactionHash !== hash || receipt.blockHash !== block.hash) throw new ApiError("Replacement is not confirmed.", 409);
  const decoded = decodeFunctionData({ abi: prepaidAbi, data: old.input });
  if (decoded.functionName !== "executePayments") throw new ApiError("Original transaction is not a batch.");
  if (!decoded.args[0].length || decoded.args[0].length > 50) throw new ApiError("Invalid original batch size.");
  if (replacement.to?.toLowerCase() === context.prepaid && replacement.input === old.input && replacement.value === BigInt(0)) return reconcile(context, hash, repo, client, executor, claimToken);
  let failed = 0;
  for (const p of decoded.args[0]) {
    const key = { ...context, payer: normalizeAddress(p.payer), scheduleId: p.scheduleId };
    const row = await repo.getPaymentByNonce(context, key.payer, getPaymentNonce(key, { ...p, amount: p.amount.toString(), tip: p.tip.toString(), validAfter: p.validAfter.toString(), validBefore: p.validBefore.toString() }));
    if (!row) throw new ApiError("Original batch is not in this database.");
    if (row.status === "submitted" && row.claimToken && row.transactionHash === originalHash) await repo.recordSubmissionFailure(row.id, row.claimToken, originalHash, "Wallet replaced the batch transaction");
    if (row.status === "leased" && row.claimToken === claimToken && row.workerId === `user:${executor}`) await repo.releaseClaimPayments(row.claimToken, [row.id], "Wallet replaced the batch transaction");
    failed++;
  }
  return { pending: false, executed: 0, failed, reward: "0" };
}
