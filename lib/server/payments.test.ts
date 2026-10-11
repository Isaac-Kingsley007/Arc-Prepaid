import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, keccak256, toHex } from "viem";
import { createDatabase, type Database } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createSessionRepository } from "./auth";
import { validateUpload } from "./schedules";
import { apiFailure, readJson, sameOrigin } from "./http";
import { authorizationMessage, attachSignature, preparePayments } from "../payments";
import { ARC_USDC, normalizeAddress, usdcDomainSeparator, verifyPaymentSignature } from "../db/authorization";
import { initialInput } from "../../app/schedule";

const payer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const other = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const context = { chainId: 5042002, prepaid: "0x1111111111111111111111111111111111111111", usdc: ARC_USDC } as const;
describe("wallet authentication and app signing", () => {
  let pg: PGlite, server: PGLiteSocketServer, db: Database, auth: ReturnType<typeof createSessionRepository>;
  before(async () => {
    pg = await PGlite.create(); server = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
    await server.start(); db = createDatabase(`postgresql://postgres:postgres@${server.getServerConn()}/postgres`, 1);
    await migrateDatabase(db); auth = createSessionRepository(db);
  });
  after(async () => { await db?.end({ timeout: 2 }); await server?.stop(); await pg?.close(); });
  it("requires a matching signature, rotates the token and rejects replay, another origin and expired sessions", async () => {
    const origin = "http://localhost:3000", challenge = await auth.challenge(payer.address, origin);
    assert.equal(await auth.payer(challenge.token, origin), null);
    await assert.rejects(auth.verify(challenge.token, await other.signMessage({ message: challenge.message }), origin), /another wallet/);
    const signature = await payer.signMessage({ message: challenge.message });
    await assert.rejects(auth.verify(challenge.token, signature, "http://localhost:3001"), /expired/);
    const session = await auth.verify(challenge.token, signature, origin);
    assert.notEqual(session.token, challenge.token);
    assert.equal(await auth.payer(session.token, origin), normalizeAddress(payer.address));
    assert.equal(await auth.payer(session.token, "http://localhost:3001"), null);
    await assert.rejects(auth.verify(challenge.token, signature, origin), /already used/);
    const rows = await db`SELECT token_hash FROM prepaid_wallet_sessions`;
    assert.ok(rows.every((r) => r.token_hash !== session.token && r.token_hash !== challenge.token));
    await db`UPDATE prepaid_wallet_sessions SET expires_at = now() - interval '1 second'`;
    assert.equal(await auth.payer(session.token, origin), null);
  });
  it("revokes sessions and rejects expired sign-in challenges", async () => {
    const origin = "http://localhost:3000", challenge = await auth.challenge(payer.address, origin);
    await db`UPDATE prepaid_wallet_sessions SET expires_at = now() - interval '1 second'`;
    await assert.rejects(auth.verify(challenge.token, await payer.signMessage({ message: challenge.message }), origin), /expired/);
    const fresh = await auth.challenge(payer.address, origin);
    const session = await auth.verify(fresh.token, await payer.signMessage({ message: fresh.message }), origin);
    await auth.logout(session.token); assert.equal(await auth.payer(session.token, origin), null);
  });
  it("builds strict, capped windows and verifies signed routing, totals, chain and payer", async () => {
    const domain = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak256(toHex("USDC")), keccak256(toHex("2")), BigInt(5042002), ARC_USDC]));
    assert.equal(usdcDomainSeparator(5042002), domain);
    const input = { ...initialInput, payee: other.address, label: "Rent", amount: "12.345678", tip: "0.1", startDate: "2090-01-01", cadence: "day" as const, count: "3" };
    const upload = preparePayments(input, context, normalizeAddress(payer.address));
    assert.equal(upload.payments.length, 3);
    assert.equal(new Set(upload.payments.map((p) => p.salt)).size, 3);
    assert.equal(BigInt(upload.payments[0].validBefore), BigInt(upload.payments[1].validAfter) + BigInt(1));
    assert.equal(BigInt(upload.payments[2].validBefore) - BigInt(upload.payments[2].validAfter), BigInt(86401));
    for (let i = 0; i < upload.payments.length; i++) upload.payments[i] = attachSignature(upload.payments[i], await payer.signTypedData(authorizationMessage(upload, upload.payments[i])));
    assert.deepEqual(await validateUpload(upload, context, normalizeAddress(payer.address)), upload);
    await assert.rejects(validateUpload(upload, context, normalizeAddress(other.address)), /Invalid schedule/);
    await assert.rejects(validateUpload({ ...upload, chainId: 5042 }, context, upload.payer), /Invalid schedule/);
    await assert.rejects(validateUpload({ ...upload, payments: upload.payments.map((p) => ({ ...p, amount: "1" })) }, context, upload.payer), /Invalid schedule/);
    await assert.rejects(verifyPaymentSignature(upload, { ...upload.payments[0], tip: "2" }));
    assert.equal(authorizationMessage(upload, upload.payments[0]).message.value, BigInt(12445678));
  });
  it("rejects cross-origin writes and oversized bodies without leaking server errors", async () => {
    const original = process.env.APP_ORIGIN; process.env.APP_ORIGIN = "http://localhost:3000";
    try {
      assert.throws(() => sameOrigin(new Request("http://localhost:3000/api/auth", { headers: { origin: "https://attacker.example" } })), /origin/);
      sameOrigin(new Request("http://localhost:3000/api/auth", { headers: { origin: "http://localhost:3000" } }));
      await assert.rejects(readJson(new Request("http://localhost:3000", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ large: "a".repeat(100_001) }) })), /too large/);
      assert.ok(!(await apiFailure(new Error("postgresql://SECRET")).text()).includes("SECRET"));
    } finally { if (original === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = original; }
  });
});
