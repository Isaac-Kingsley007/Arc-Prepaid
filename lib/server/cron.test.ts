import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, toHex, zeroHash, type Hex } from "viem";
import { createDatabase, type Database } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createPaymentRepository } from "../db/payments";
import { ARC_USDC, normalizeAddress, toContractPayment, type SignedPayment } from "../db/authorization";
import { attachSignature, authorizationMessage } from "../payments";
import { prepaidAbi } from "../prepaid";
import { createTransactionJournal } from "../relayer/journal";
import { allowedBatch, cronConfig } from "../relayer/cron-config";
import { recoverTransaction, runCron } from "../relayer/cron";
import type { RelayerBatch } from "../relayer/types";

// Public development fixtures. No live wallet key or hosted database is used.
const payer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const executor = normalizeAddress(signer.address), context = { chainId: 5042002, prepaid: "0x1111111111111111111111111111111111111111", usdc: ARC_USDC } as const;
const blockHash = keccak256(toHex("block"));
describe("cron signed transaction journal and recovery", { concurrency: false }, () => {
  let pg: PGlite, socket: PGLiteSocketServer, db: Database, repo: ReturnType<typeof createPaymentRepository>, journal: ReturnType<typeof createTransactionJournal>;
  before(async () => { pg = await PGlite.create(); socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 }); await socket.start();
    db = createDatabase(`postgresql://postgres:postgres@${socket.getServerConn()}/postgres`, 1); await migrateDatabase(db); repo = createPaymentRepository(db); journal = createTransactionJournal(db); });
  after(async () => { await db?.end({ timeout: 2 }); await socket?.stop(); await pg?.close(); });
  async function batch(): Promise<RelayerBatch> {
    const key = { ...context, payer: normalizeAddress(payer.address), scheduleId: keccak256(toHex(randomUUID())) };
    const p: SignedPayment = { payee: executor, amount: "100", tip: "10", validAfter: "100", validBefore: "1000", salt: keccak256(toHex(randomUUID())), v: 27, r: zeroHash, s: zeroHash };
    const signed = attachSignature(p, await payer.signTypedData(authorizationMessage(key, p)));
    await repo.saveSchedule({ ...key, payments: [signed] });
    const claim = await repo.claimDuePayments(context, "150", `user:${executor}`, 1, 600);
    return { context, claimToken: claim.claimToken, ids: claim.payments.map((r) => r.id),
      payments: claim.payments.map((r) => ({ ...signed, payer: r.payer, scheduleId: r.scheduleId })), reward: "7", gas: "600000",
      maxFeePerGas: "30000000000", maxPriorityFeePerGas: "1000000000", estimatedCost: "18000000000000000", expiresAt: claim.payments[0].leaseUntil!.toISOString() };
  }
  function sign(b: RelayerBatch, nonce: number, account = signer): Promise<Hex> {
    return account.signTransaction({ chainId: context.chainId, type: "eip1559", nonce, to: context.prepaid, value: BigInt(0), gas: BigInt(b.gas),
      maxFeePerGas: BigInt(b.maxFeePerGas), maxPriorityFeePerGas: BigInt(b.maxPriorityFeePerGas),
      data: encodeFunctionData({ abi: prepaidAbi, functionName: "executePayments", args: [b.payments.map((p) => toContractPayment({ ...context, payer: p.payer, scheduleId: p.scheduleId }, p))] }) });
  }
  it("stores nonce-zero signed bytes and reserves payments atomically; duplicate nonces and wrong signers roll back", async () => {
    const first = await batch(), raw = await sign(first, 0), saved = await journal.save(first, executor, raw);
    assert.equal(saved.nonce, "0"); assert.equal(saved.hash, keccak256(raw));
    assert.equal((await journal.pending(context, executor))[0].raw, raw);
    assert.equal((await repo.getRelayerClaim(context, first.claimToken, executor))[0].status, "submitted");
    assert.equal(await repo.releaseClaims(first.claimToken, "attempted release"), 0);
    const second = await batch();
    await assert.rejects(journal.save(second, executor, await sign(second, 0)), /duplicate/);
    assert.equal((await repo.getRelayerClaim(context, second.claimToken, executor))[0].status, "leased");
    await assert.rejects(journal.save(second, executor, await sign(second, 1, payer)), /does not match/);
    assert.equal((await journal.pending(context, executor)).length, 1);
    await repo.releaseClaims(second.claimToken, "test cleanup");
  });
  it("recovers a crash before broadcast using exactly the same bytes and credits only its verified receipt", async () => {
    const [saved] = await journal.pending(context, executor), [row] = await repo.getRelayerClaim(context, saved.claimToken, executor);
    const data = encodeFunctionData({ abi: prepaidAbi, functionName: "executePayments", args: [[toContractPayment(row, row)]] });
    let visible = false, sends = 0;
    const client = { getTransaction: async () => { if (!visible) throw new Error("not yet broadcast"); return { from: executor, to: context.prepaid, nonce: 0, value: BigInt(0), input: data }; },
      getTransactionCount: async () => 0, waitForTransactionReceipt: async () => ({}), getBlock: async () => ({ hash: blockHash }),
      getTransactionReceipt: async () => ({ status: "success", transactionHash: saved.hash, blockNumber: BigInt(123), blockHash,
        logs: [{ address: context.prepaid, removed: false, topics: encodeEventTopics({ abi: prepaidAbi, eventName: "PaymentExecuted", args: { payer: row.payer, scheduleId: row.scheduleId, nonce: row.nonce } }),
          data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], [executor, BigInt(100), BigInt(10), executor, BigInt(7), BigInt(3)]) }] }),
    } as unknown as Parameters<typeof recoverTransaction>[5];
    const broadcast = async (raw: Hex) => { assert.equal(raw, saved.raw); sends++; visible = true; return saved.hash; };
    assert.equal(await recoverTransaction(saved, context, executor, repo, journal, client, broadcast, () => {}), true);
    assert.equal((await journal.pending(context, executor)).length, 0);
    assert.equal((await repo.getPaymentByNonce(context, row.payer, row.nonce))?.status, "executed");
    assert.equal(await recoverTransaction(saved, context, executor, repo, journal, client, broadcast, () => {}), true);
    assert.equal(sends, 1);
  });
  it("keeps uncertain transactions submitted and never creates another transaction for their nonce", async () => {
    const b = await batch(), saved = await journal.save(b, executor, await sign(b, 1));
    const client = { getTransaction: async () => { throw new Error("RPC unavailable"); }, getTransactionCount: async () => 1,
      waitForTransactionReceipt: async () => { throw new Error("timeout"); } } as unknown as Parameters<typeof recoverTransaction>[5];
    const sent: Hex[] = [];
    const broadcast = async (raw: Hex) => { sent.push(raw); throw new Error("broadcast response lost"); };
    assert.equal(await recoverTransaction(saved, context, executor, repo, journal, client, broadcast, () => {}), false);
    assert.equal(await recoverTransaction(saved, context, executor, repo, journal, client, broadcast, () => {}), false);
    assert.deepEqual(sent, [saved.raw, saved.raw]);
    assert.equal((await repo.getRelayerClaim(context, b.claimToken, executor))[0].status, "submitted");
    const advanced = { ...client, getTransactionCount: async () => 2 } as unknown as Parameters<typeof recoverTransaction>[5];
    await assert.rejects(recoverTransaction(saved, context, executor, repo, journal, advanced, broadcast, () => {}), /nonce was consumed/);
    assert.equal(sent.length, 2);
  });
  it("makes dry runs read-only and enforces the requested bounded-loss policy", async () => {
    const beforeRows = JSON.stringify(await db`SELECT id,status,updated_at FROM prepaid_payments ORDER BY id`);
    const client = { getBlock: async () => ({ timestamp: BigInt(150) }) } as unknown as Parameters<typeof recoverTransaction>[5];
    await runCron({ context, executor, repo, journal, client, dryRun: true, config: cronConfig({}),
      broadcast: async () => { throw new Error("must not broadcast"); }, log: () => {} });
    assert.equal(JSON.stringify(await db`SELECT id,status,updated_at FROM prepaid_payments ORDER BY id`), beforeRows);
    const config = cronConfig({});
    assert.equal(allowedBatch("0", "19000000000000000", config), true);
    assert.equal(allowedBatch("0", "21000000000000000", config), false);
    assert.equal(allowedBatch("1000000", "110000000000000000", config), false);
    assert.equal(allowedBatch("0", "1000000000000000", cronConfig({ RELAYER_ALLOW_UNPROFITABLE: "false" })), false);
    assert.throws(() => cronConfig({ RELAYER_BATCH_SIZE: "11" }));
  });
});
