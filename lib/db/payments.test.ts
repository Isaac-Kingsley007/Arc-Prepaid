import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, parseSignature, toHex, zeroHash } from "viem";
import { createDatabase, type Database } from "./client";
import { migrateDatabase } from "./migrate";
import { createPaymentRepository } from "./payments";
import { ARC_USDC, getPaymentNonce, receiveAuthorizationTypes, toContractPayment, type ScheduleKey, type SignedPayment } from "./authorization";

// Public development fixture only. No actual wallet or Neon credentials are used.
const payer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const other = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const context = { chainId: 5042002, prepaid: "0x1111111111111111111111111111111111111111", usdc: ARC_USDC } as const;
const hash = keccak256(toHex("transaction")), blockHash = keccak256(toHex("block"));
function scheduleKey(): ScheduleKey {
  return { ...context, payer: payer.address, scheduleId: keccak256(toHex(randomUUID())) };
}
async function sign(key: ScheduleKey, changes: Partial<SignedPayment> = {}): Promise<SignedPayment> {
  const payment: SignedPayment = {
    payee: other.address, amount: "100000000", tip: "1000000", validAfter: "100", validBefore: "1000",
    salt: keccak256(toHex(randomUUID())), v: 27, r: zeroHash, s: zeroHash, ...changes,
  };
  const signature = await payer.signTypedData({
    domain: { name: "USDC", version: "2", chainId: key.chainId, verifyingContract: key.usdc },
    types: receiveAuthorizationTypes, primaryType: "ReceiveWithAuthorization",
    message: { from: key.payer, to: key.prepaid, value: BigInt(payment.amount) + BigInt(payment.tip),
      validAfter: BigInt(payment.validAfter), validBefore: BigInt(payment.validBefore), nonce: getPaymentNonce(key, payment) },
  });
  const parsed = parseSignature(signature);
  return { ...payment, v: Number(parsed.v), r: parsed.r, s: parsed.s };
}

describe("Postgres.js payment repository (embedded PostgreSQL over TCP)", { concurrency: false }, () => {
  let pg: PGlite, server: PGLiteSocketServer, db: Database;
  let repo: ReturnType<typeof createPaymentRepository>;
  before(async () => {
    pg = await PGlite.create();
    server = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
    await server.start();
    db = createDatabase(`postgresql://postgres:postgres@${server.getServerConn()}/postgres`, 1);
    repo = createPaymentRepository(db);
  });
  after(async () => {
    if (db) await db.end({ timeout: 2 });
    if (server) await server.stop();
    if (pg) await pg.close();
  });

  it("creates the schema and reapplies migrations without modifying it", async () => {
    assert.deepEqual(await migrateDatabase(db), ["001_payments.sql", "002_wallet_sessions.sql"]);
    assert.deepEqual(await migrateDatabase(db), []);
    const rows = await db`SELECT name FROM prepaid_migrations`;
    assert.equal(rows.length, 2);
  });

  it("rejects changed migration history and rolls back invalid migrations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prepaid-db-migration-"));
    try {
      await writeFile(join(directory, "001_payments.sql"), "SELECT 2;");
      await assert.rejects(migrateDatabase(db, directory), /differ from this checkout/);
      const original = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../../db/migrations/001_payments.sql", import.meta.url), "utf8"));
      await writeFile(join(directory, "001_payments.sql"), original);
      const sessions = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../../db/migrations/002_wallet_sessions.sql", import.meta.url), "utf8"));
      await writeFile(join(directory, "002_wallet_sessions.sql"), sessions);
      await writeFile(join(directory, "003_invalid.sql"), "CREATE TABLE prepaid_should_rollback(id integer); SELECT missing_column;");
      await assert.rejects(migrateDatabase(db, directory));
      const [row] = await db`SELECT to_regclass('prepaid_should_rollback') AS name`;
      assert.equal(row.name, null);
      assert.equal((await db`SELECT name FROM prepaid_migrations`).length, 2);
    } finally {
      assert.equal(dirname(directory), resolve(tmpdir()));
      assert.ok(directory.startsWith(join(tmpdir(), "prepaid-db-migration-")));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("saves valid signatures atomically, preserves exact large values and supports JSON/contract payloads", async () => {
    const key = scheduleKey();
    const p = await sign(key, { amount: "9007199254740993123456789" });
    const schedule = await repo.saveSchedule({ ...key, payments: [p], label: "Rent", metadata: { interval: "monthly", timezone: "Asia/Calcutta" } });
    const [row] = await repo.listSchedulePayments(key);
    assert.equal(row.amount, p.amount);
    assert.equal(row.nonce, getPaymentNonce(key, p));
    assert.equal(row.status, "pending");
    assert.equal(schedule.label, "Rent");
    assert.equal(toContractPayment(row, row).amount, BigInt(p.amount));
    assert.doesNotThrow(() => JSON.stringify(row));
    assert.equal((await repo.getSchedule(key))?.id, schedule.id);
    assert.ok((await repo.listPayerSchedules(context, payer.address)).some((s) => s.id === schedule.id));
    assert.equal(await repo.getSchedule(scheduleKey()), null);
  });

  it("makes save retries idempotent and refuses schedule mutation", async () => {
    const key = scheduleKey(), p = await sign(key);
    const first = await repo.saveSchedule({ ...key, payments: [p] });
    const retry = await repo.saveSchedule({ ...key, payments: [p] });
    assert.equal(first.id, retry.id);
    assert.equal((await repo.listSchedulePayments(key)).length, 1);
    await assert.rejects(repo.saveSchedule({ ...key, payments: [await sign(key)] }), /immutable/);
    assert.equal((await repo.listSchedulePayments(key))[0].nonce, getPaymentNonce(key, p));
  });

  it("rejects tampered signatures, duplicate salts, malformed hex and fractional/out-of-range values before insertion", async () => {
    const key = scheduleKey(), p = await sign(key);
    await assert.rejects(repo.saveSchedule({ ...key, payments: [{ ...p, amount: "99999999", tip: "1000001" }] }), /signature/);
    await assert.rejects(repo.saveSchedule({ ...key, payments: [p, p] }), /unique salt/);
    for (const amount of ["1.5", "01", "-1", (BigInt(1) << BigInt(256)).toString()]) {
      await assert.rejects(repo.saveSchedule({ ...key, payments: [{ ...p, amount }] }), /uint256/);
    }
    await assert.rejects(repo.saveSchedule({ ...key, payments: [{ ...p, salt: "0x01" }] }), /bytes32/);
    assert.equal(await repo.getSchedule(key), null);
    await assert.rejects(repo.saveSchedule({ ...key, payments: [] }), /payment count/);
  });

  it("enforces integer constraints in PostgreSQL even if a caller bypasses validation", async () => {
    const key = scheduleKey(), p = await sign(key);
    await repo.saveSchedule({ ...key, payments: [p] });
    const [row] = await repo.listSchedulePayments(key);
    await assert.rejects(db`UPDATE prepaid_payments SET amount = 1.5 WHERE id = ${row.id}`, /prepaid_uint256/);
    await assert.rejects(db`UPDATE prepaid_payments SET status = 'executed' WHERE id = ${row.id}`, /check constraint/);
  });

  it("discovers exclusive windows, scopes deployments and treats labels as parameterized data", async () => {
    const key = scheduleKey(), p = await sign(key);
    const label = "'); DROP TABLE prepaid_payments; --";
    await repo.saveSchedule({ ...key, payments: [p], label });
    assert.equal((await repo.getSchedule(key))?.label, label);
    assert.ok(!(await repo.listDuePayments(context, "100")).some((row) => row.nonce === getPaymentNonce(key, p)));
    assert.ok((await repo.listDuePayments(context, "101")).some((row) => row.nonce === getPaymentNonce(key, p)));
    assert.ok(!(await repo.listDuePayments(context, "1000")).some((row) => row.nonce === getPaymentNonce(key, p)));
    assert.deepEqual(await repo.listDuePayments({ ...context, prepaid: "0x2222222222222222222222222222222222222222" }, "101"), []);
    assert.deepEqual(await repo.listDuePayments({ ...context, chainId: 5042 }, "101"), []);
  });

  it("claims disjoint work, fences stale claims, releases unsubmitted work and reclaims expired leases", async () => {
    // Use a unique time range to isolate these candidates from other tests.
    const key = scheduleKey();
    const payments = await Promise.all([1, 2].map(() => sign(key, { validAfter: "2000", validBefore: "3000" })));
    await repo.saveSchedule({ ...key, payments });
    const first = await repo.claimDuePayments(context, "2001", "cron-a", 1);
    const second = await repo.claimDuePayments(context, "2001", "cron-b", 1);
    assert.equal(first.payments.length, 1); assert.equal(second.payments.length, 1);
    assert.notEqual(first.payments[0].id, second.payments[0].id);
    assert.equal((await repo.claimDuePayments(context, "2001", "cron-c")).payments.length, 0);
    await db`UPDATE prepaid_payments SET lease_until = now() - interval '1 second' WHERE id = ${first.payments[0].id}`;
    const reclaimed = await repo.claimDuePayments(context, "2001", "cron-c");
    assert.equal(reclaimed.payments[0].id, first.payments[0].id);
    assert.equal(reclaimed.payments[0].attemptCount, 2);
    await assert.rejects(repo.recordSubmission([first.payments[0].id], first.claimToken, hash, other.address), /Claim expired/);
    assert.equal(await repo.releaseClaims(first.claimToken, "stale worker"), 0);
    assert.equal(await repo.releaseClaims(reclaimed.claimToken, "simulation rejected"), 1);
    assert.equal((await repo.claimDuePayments(context, "2001", "cron-d")).payments.length, 0);
  });

  it("records a batch submission atomically, never reclaims uncertain transactions, and reconciles per-item outcomes", async () => {
    const key = scheduleKey();
    const payments = await Promise.all([1, 2].map(() => sign(key, { validAfter: "4000", validBefore: "5000" })));
    await repo.saveSchedule({ ...key, payments });
    const claim = await repo.claimDuePayments(context, "4001", "cron");
    const ids = claim.payments.map((row) => row.id);
    await assert.rejects(repo.recordSubmission([...ids, randomUUID()], claim.claimToken, hash, other.address), /Claim expired/);
    assert.equal((await repo.listSchedulePayments(key))[0].status, "leased");
    await repo.recordSubmission(ids, claim.claimToken, hash, other.address);
    await repo.recordSubmission(ids, claim.claimToken, hash, other.address);
    assert.equal(await repo.releaseClaims(claim.claimToken, "RPC timed out"), 0);
    assert.equal((await repo.claimDuePayments(context, "4001", "human")).payments.length, 0);
    assert.ok((await repo.listSubmittedPayments(context)).some((row) => row.id === ids[0]));
    assert.equal(await repo.recordExecution(context, { payer: key.payer, nonce: claim.payments[0].nonce,
      transactionHash: hash, executor: other.address, blockNumber: "42", blockHash }), true);
    assert.equal(await repo.recordSubmissionFailure(ids[1], claim.claimToken, hash, "payer lacks funds"), true);
    const rows = await repo.listSchedulePayments(key);
    assert.equal(rows.filter((row) => row.status === "executed").length, 1);
    assert.equal(rows.filter((row) => row.status === "pending").length, 1);
    assert.equal(await repo.recordSubmissionFailure(ids[0], claim.claimToken, hash, "late worker"), false);
    assert.equal(await repo.recordExecution(context, { payer: key.payer, nonce: claim.payments[0].nonce,
      transactionHash: hash, executor: other.address, blockNumber: "42", blockHash }), true);
    assert.equal(await repo.recordExecution(context, { payer: key.payer, nonce: claim.payments[0].nonce,
      transactionHash: keccak256(toHex("different")), executor: other.address, blockNumber: "43", blockHash }), false);
  });

  it("mirrors confirmed cancellation while preserving submitted work for earlier execution receipts", async () => {
    const key = scheduleKey();
    const payments = await Promise.all([1, 2].map(() => sign(key, { validAfter: "6000", validBefore: "7000" })));
    await repo.saveSchedule({ ...key, payments });
    const claim = await repo.claimDuePayments(context, "6001", "cron", 1);
    await repo.recordSubmission([claim.payments[0].id], claim.claimToken, hash, other.address);
    assert.equal(await repo.recordScheduleCancellation(key, { transactionHash: hash, blockNumber: "51", blockHash }), true);
    assert.equal((await repo.listSchedulePayments(key)).filter((row) => row.status === "cancelled").length, 1);
    assert.equal((await repo.listDuePayments(context, "6001")).length, 0);
    assert.equal(await repo.recordExecution(context, { payer: key.payer, nonce: claim.payments[0].nonce,
      transactionHash: hash, executor: other.address, blockNumber: "50", blockHash }), true);
    assert.equal((await repo.listSchedulePayments(key)).filter((row) => row.status === "executed").length, 1);
  });

  it("distinguishes unavailable authorizations and expired windows without fabricating execution", async () => {
    const key = scheduleKey();
    const payments = await Promise.all([1, 2].map(() => sign(key, { validAfter: "8000", validBefore: "9000" })));
    await repo.saveSchedule({ ...key, payments });
    assert.equal(await repo.recordAuthorizationUnavailable(context, key.payer, getPaymentNonce(key, payments[0])), true);
    await repo.expirePayments(context, "9000");
    const rows = await repo.listSchedulePayments(key);
    assert.equal(rows[0].status, "unavailable"); assert.equal(rows[1].status, "expired");
    assert.equal(rows[0].transactionHash, null); assert.equal(rows[1].executor, null);
  });

  it("runs the migration/check CLI with an env file and reports failures without exposing credentials", async () => {
    await db.end({ timeout: 2 });
    const directory = await mkdtemp(join(tmpdir(), "prepaid-db-cli-"));
    const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres`;
    const cli = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
    async function run(script: string, databaseUrl = url) {
      await writeFile(join(directory, ".env.local"), `DATABASE_URL="${databaseUrl}"\n`);
      const path = fileURLToPath(new URL(`../../scripts/${script}.ts`, import.meta.url));
      const env = { ...process.env };
      delete env.DATABASE_URL;
      const child = spawn(process.execPath, [cli, "--conditions=react-server", "--env-file=.env.local", path], {
        cwd: directory, env, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      const status = await new Promise<number | null>((done, reject) => {
        child.once("error", reject); child.once("close", done);
      });
      return { status, output };
    }
    try {
      const migrated = await run("db-migrate");
      assert.equal(migrated.status, 0, migrated.output);
      assert.match(migrated.output, /already applied/);
      const checked = await run("db-check");
      assert.equal(checked.status, 0, checked.output);
      assert.match(checked.output, /all four tables are ready/);
      const failed = await run("db-migrate", "https://private-password.invalid");
      assert.equal(failed.status, 1);
      assert.match(failed.output, /migration failed/);
      assert.ok(!failed.output.includes("private-password"));
    } finally {
      db = createDatabase(url, 1);
      assert.equal(dirname(directory), resolve(tmpdir()));
      assert.ok(directory.startsWith(join(tmpdir(), "prepaid-db-cli-")));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
