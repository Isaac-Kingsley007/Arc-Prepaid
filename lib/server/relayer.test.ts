import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, toHex, zeroHash, TransactionReceiptNotFoundError, type TransactionReceipt } from "viem";
import { createDatabase, type Database } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createPaymentRepository } from "../db/payments";
import { ARC_USDC, normalizeAddress, toContractPayment, type SignedPayment } from "../db/authorization";
import { authorizationMessage, attachSignature } from "../payments";
import { prepaidAbi } from "../prepaid";
import { checkPayments, claimBatch, reconcile, rewardFor, settleReplacement } from "../relayer/service";

const payer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const relayer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const executor = normalizeAddress(relayer.address);
const context = { chainId: 5042002, prepaid: "0x1111111111111111111111111111111111111111", usdc: ARC_USDC } as const;
const hash = keccak256(toHex("batch")), replacementHash = keccak256(toHex("replacement")), blockHash = keccak256(toHex("block"));
describe("user relayer with PostgreSQL and signed authorizations", { concurrency: false }, () => {
  let pg: PGlite, socket: PGLiteSocketServer, db: Database, repo: ReturnType<typeof createPaymentRepository>;
  before(async () => { pg = await PGlite.create(); socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 }); await socket.start();
    db = createDatabase(`postgresql://postgres:postgres@${socket.getServerConn()}/postgres`, 1); await migrateDatabase(db); repo = createPaymentRepository(db); });
  after(async () => { await db?.end({ timeout: 2 }); await socket?.stop(); await pg?.close(); });
  async function save(count = 1) {
    const key = { ...context, payer: normalizeAddress(payer.address), scheduleId: keccak256(toHex(randomUUID())) };
    const payments: SignedPayment[] = [];
    for (let i = 0; i < count; i++) {
      const p: SignedPayment = { payee: executor, amount: "100", tip: "10", validAfter: "100", validBefore: "1000", salt: keccak256(toHex(randomUUID())), v: 27, r: zeroHash, s: zeroHash };
      payments.push(attachSignature(p, await payer.signTypedData(authorizationMessage(key, p))));
    }
    await repo.saveSchedule({ ...key, payments }); return repo.listSchedulePayments(key);
  }
  function fakeClient() {
    return { getBlock: async () => ({ timestamp: BigInt(150), hash: blockHash }),
      readContract: async ({ functionName }: { functionName: string }): Promise<bigint | boolean> => functionName === "balanceOf" ? BigInt(1000000) : false,
      simulateContract: async ({ args }: { args: unknown[][] }) => ({ result: BigInt(args[0].length) }),
      estimateContractGas: async () => BigInt(500000), estimateFeesPerGas: async () => ({ maxFeePerGas: BigInt(30000000000), maxPriorityFeePerGas: BigInt(1000000000) }),
      getBalance: async () => BigInt("100000000000000000000"),
    };
  }
  it("accounts for payer aggregate balance, cancellation, revoked nonces and exact tip rounding", async () => {
    const rows = await save(2), mock = fakeClient();
    mock.readContract = async ({ functionName }) => functionName === "balanceOf" ? BigInt(150) : false;
    const client = mock as unknown as Parameters<typeof checkPayments>[2];
    const checked = await checkPayments(rows, context, client);
    assert.equal(checked[0].reason, null); assert.match(checked[1].reason!, /balance/);
    mock.readContract = async ({ functionName }) => functionName === "balanceOf" ? BigInt(1000000) : true;
    assert.match((await checkPayments(rows, context, client))[0].reason!, /cancelled/);
    assert.equal(rewardFor("1"), BigInt(0)); assert.equal(rewardFor("101"), BigInt(70));
    await db`DELETE FROM prepaid_payments`; await db`DELETE FROM prepaid_schedules`;
  });
  it("reserves disjoint batches and computes a native-precision maximum fee budget", async () => {
    await save(2); const client = fakeClient() as unknown as Parameters<typeof claimBatch>[4];
    const first = await claimBatch(context, executor, 1, repo, client), second = await claimBatch(context, executor, 1, repo, client);
    assert.notEqual(first.ids[0], second.ids[0]); assert.equal(first.reward, "7");
    assert.equal(first.estimatedCost, (BigInt(600000) * BigInt(30000000000)).toString());
    assert.equal((await repo.getRelayerClaim(context, first.claimToken, normalizeAddress(payer.address))).length, 0);
    await repo.releaseClaims(first.claimToken, "test"); await repo.releaseClaims(second.claimToken, "test");
    await db`DELETE FROM prepaid_payments`; await db`DELETE FROM prepaid_schedules`;
  });
  it("releases claims when simulation fails and refuses to quote insufficient gas funds", async () => {
    await save(); const mock = fakeClient(); mock.simulateContract = async () => ({ result: BigInt(0) });
    await assert.rejects(claimBatch(context, executor, 1, repo, mock as unknown as Parameters<typeof claimBatch>[4]), /simulation/);
    assert.equal((await db`SELECT status FROM prepaid_payments`)[0].status, "pending");
    await db`UPDATE prepaid_payments SET retry_after = now()`;
    mock.simulateContract = async ({ args }) => ({ result: BigInt(args[0].length) }); mock.getBalance = async () => BigInt(0);
    await assert.rejects(claimBatch(context, executor, 1, repo, mock as unknown as Parameters<typeof claimBatch>[4]), /more USDC/);
    await db`DELETE FROM prepaid_payments`; await db`DELETE FROM prepaid_schedules`;
  });
  it("preserves uncertain submissions, reconciles mixed outcomes and fences old failed claims", async () => {
    await save(2); const mock = fakeClient(); const client = mock as unknown as Parameters<typeof claimBatch>[4];
    const batch = await claimBatch(context, executor, 2, repo, client);
    const rows = await repo.getRelayerClaim(context, batch.claimToken, executor);
    const input = encodeFunctionData({ abi: prepaidAbi, functionName: "executePayments", args: [rows.map((p) => toContractPayment(p, p))] });
    const tx = { to: context.prepaid, from: executor, value: BigInt(0), nonce: 1, input };
    let confirmed = false;
    const receipt = { status: "success", transactionHash: hash, blockNumber: BigInt(123), blockHash,
      logs: [
        { address: context.prepaid, removed: false, topics: encodeEventTopics({ abi: prepaidAbi, eventName: "PaymentExecuted", args: { payer: rows[0].payer, scheduleId: rows[0].scheduleId, nonce: rows[0].nonce } }),
          data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], [executor, BigInt(100), BigInt(10), executor, BigInt(7), BigInt(3)]) },
        { address: context.prepaid, removed: false, topics: encodeEventTopics({ abi: prepaidAbi, eventName: "PaymentFailed", args: { index: BigInt(1), payer: rows[1].payer, scheduleId: rows[1].scheduleId } }), data: encodeAbiParameters([{ type: "bytes" }], ["0x"]) },
      ],
    } as unknown as TransactionReceipt;
    const full = { ...mock, getTransaction: async () => tx, getTransactionReceipt: async () => { if (!confirmed) throw new TransactionReceiptNotFoundError({ hash }); return receipt; } } as unknown as Parameters<typeof reconcile>[3];
    assert.equal((await reconcile(context, hash, repo, full, executor, batch.claimToken)).pending, true);
    await repo.touchSubmittedHash(context, hash);
    assert.equal((await db`SELECT count(*)::int AS count FROM prepaid_payments WHERE status = 'submitted'`)[0].count, 2);
    assert.equal(await repo.releaseClaims(batch.claimToken, "uncertain"), 0);
    confirmed = true;
    assert.deepEqual(await reconcile(context, hash, repo, full, executor, batch.claimToken), { pending: false, executed: 1, failed: 1, reward: "7" });
    assert.equal((await repo.getPaymentByNonce(context, rows[0].payer, rows[0].nonce))?.status, "executed");
    assert.equal((await repo.getPaymentByNonce(context, rows[1].payer, rows[1].nonce))?.status, "pending");
    await db`UPDATE prepaid_payments SET retry_after = now()`;
    const next = await claimBatch(context, executor, 1, repo, client);
    await reconcile(context, hash, repo, full, executor, batch.claimToken);
    assert.equal((await repo.getRelayerClaim(context, next.claimToken, executor)).length, 1);
    await assert.rejects(reconcile(context, hash, repo, full, normalizeAddress(payer.address)), /not your/);
    // A confirmed wallet replacement consumes the old nonce, safely releasing only its original claim.
    const replacement = { ...full, getTransaction: async ({ hash: requested }: { hash: string }) => requested === hash ? tx : { ...tx, to: executor, input: "0x" },
      getTransactionReceipt: async () => ({ ...receipt, transactionHash: replacementHash, logs: [] }) } as unknown as Parameters<typeof settleReplacement>[6];
    await settleReplacement(context, hash, replacementHash, executor, batch.claimToken, repo, replacement);
    assert.equal((await repo.getRelayerClaim(context, next.claimToken, executor)).length, 1);
    // A copied signature repeated in a real batch earns its tip only once.
    const duplicated = rows[1];
    const duplicateInput = encodeFunctionData({ abi: prepaidAbi, functionName: "executePayments", args: [[toContractPayment(duplicated, duplicated), toContractPayment(duplicated, duplicated)]] });
    const duplicateReceipt = { ...receipt, transactionHash: replacementHash, logs: [
      { ...receipt.logs[0], topics: encodeEventTopics({ abi: prepaidAbi, eventName: "PaymentExecuted", args: { payer: duplicated.payer, scheduleId: duplicated.scheduleId, nonce: duplicated.nonce } }) },
      receipt.logs[1],
    ] };
    const duplicateClient = { ...mock, getTransaction: async () => ({ ...tx, input: duplicateInput }), getTransactionReceipt: async () => duplicateReceipt } as unknown as Parameters<typeof reconcile>[3];
    assert.deepEqual(await reconcile(context, replacementHash, repo, duplicateClient, executor, next.claimToken), { pending: false, executed: 1, failed: 1, reward: "7" });
  });
});
