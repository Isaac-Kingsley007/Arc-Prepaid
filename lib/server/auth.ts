import "server-only";
import { arcChain } from "../network";
import { createHash, randomBytes } from "node:crypto";
import { recoverMessageAddress, type Address, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { cookies } from "next/headers";
import { getDatabase, type Database } from "../db/client";
import { normalizeAddress } from "../db/authorization";
import { ApiError } from "./http";

export const SESSION_COOKIE = `prepaid-session-${arcChain.id}`;
function digest(token: string) { return createHash("sha256").update(token).digest("hex"); }
export function createSessionRepository(db: Database = getDatabase()) {
  return {
    async challenge(payer: Address, origin: string) {
      const token = randomBytes(32).toString("hex"), nonce = randomBytes(16).toString("hex");
      const expires = new Date(Date.now() + 300_000);
      const message = createSiweMessage({ address: normalizeAddress(payer), chainId: arcChain.id,
        domain: new URL(origin).host, uri: origin, version: "1", nonce, expirationTime: expires,
        statement: "Sign in to PrePaid to view and save your schedules. This does not authorize a payment." });
      await db`DELETE FROM prepaid_wallet_sessions WHERE expires_at <= now()`;
      await db`INSERT INTO prepaid_wallet_sessions(token_hash,payer,message,origin,expires_at)
        VALUES (${digest(token)},${normalizeAddress(payer)},${message},${origin},${expires})`;
      return { token, message };
    },
    async verify(token: string, signature: Hex, origin: string) {
      const [row] = await db<{ payer: Address; message: string }[]>`SELECT payer,message FROM prepaid_wallet_sessions
        WHERE token_hash = ${digest(token)} AND NOT authenticated AND origin = ${origin} AND expires_at > now()`;
      if (!row) throw new ApiError("Sign-in challenge expired or already used.", 401);
      let signer: Address;
      try { signer = normalizeAddress(await recoverMessageAddress({ message: row.message, signature })); }
      catch { throw new ApiError("Invalid wallet sign-in signature.", 401); }
      if (signer !== row.payer) throw new ApiError("Sign-in signature belongs to another wallet.", 401);
      // Rotate the cookie and consume the challenge atomically; even concurrent replay fails.
      const next = randomBytes(32).toString("hex");
      const updated = await db`UPDATE prepaid_wallet_sessions SET token_hash = ${digest(next)}, authenticated = true,
        expires_at = now() + interval '8 hours' WHERE token_hash = ${digest(token)} AND NOT authenticated AND expires_at > now()
        RETURNING payer`;
      if (!updated.length) throw new ApiError("Sign-in challenge already used.", 401);
      return { token: next, payer: row.payer };
    },
    async payer(token: string | undefined, origin: string): Promise<Address | null> {
      if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
      const [row] = await db<{ payer: Address }[]>`SELECT payer FROM prepaid_wallet_sessions
        WHERE token_hash = ${digest(token)} AND authenticated AND origin = ${origin} AND expires_at > now()`;
      return row?.payer ?? null;
    },
    async logout(token: string | undefined) { if (token) await db`DELETE FROM prepaid_wallet_sessions WHERE token_hash = ${digest(token)}`; },
  };
}
export async function sessionPayer(origin: string) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const payer = await createSessionRepository().payer(token, origin);
  if (!payer) throw new ApiError("Sign in with your wallet first.", 401);
  return payer;
}
export async function setSession(token: string, origin: string, maxAge: number) {
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: origin.startsWith("https:"), sameSite: "strict", path: "/", maxAge });
}
