import "server-only";
import { encodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, type Address, type Hex, type TransactionSerialized } from "viem";
import { normalizeAddress, normalizeContext, toContractPayment, type ChainContext } from "../db/authorization";
import { prepaidAbi } from "../prepaid";
import { getDatabase, type Database } from "../db/client";
import type { RelayerBatch } from "./types";

export type JournalTransaction = { hash: Hex; raw: Hex; claimToken: string; nonce: string; prepaid: Address };
export function createTransactionJournal(db: Database = getDatabase()) {
  return {
    async pending(context: ChainContext, executor: Address): Promise<JournalTransaction[]> {
      const key = normalizeContext(context), owner = normalizeAddress(executor);
      const rows = await db<{ transaction_hash: Hex; signed_transaction: Hex; claim_token: string; nonce: string; prepaid_address: Address }[]>`
        SELECT transaction_hash,signed_transaction,claim_token,nonce,prepaid_address FROM prepaid_relayer_transactions
        WHERE chain_id = ${key.chainId} AND executor = ${owner} AND NOT confirmed ORDER BY nonce`;
      return rows.map((r) => ({ hash: r.transaction_hash, raw: r.signed_transaction, claimToken: r.claim_token, nonce: r.nonce, prepaid: r.prepaid_address }));
    },
    async save(batch: RelayerBatch, executor: Address, raw: Hex): Promise<JournalTransaction> {
      const key = normalizeContext(batch.context), owner = normalizeAddress(executor), tx = parseTransaction(raw), hash = keccak256(raw);
      const expected = encodeFunctionData({ abi: prepaidAbi, functionName: "executePayments",
        args: [batch.payments.map((p) => toContractPayment({ ...key, payer: p.payer, scheduleId: p.scheduleId }, p))] });
      const nonce = tx.nonce ?? 0;
      if (tx.chainId !== key.chainId || tx.to?.toLowerCase() !== key.prepaid || (tx.value ?? BigInt(0)) !== BigInt(0)
        || tx.data !== expected || normalizeAddress(await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized })) !== owner) throw new Error("Signed transaction does not match its batch context");
      await db.begin(async (sql) => {
        const updated = await sql`UPDATE prepaid_payments p SET status = 'submitted', transaction_hash = ${hash}, executor = ${owner},
          lease_until = NULL, updated_at = now() FROM prepaid_schedules s WHERE p.schedule_pk = s.id
          AND s.chain_id = ${key.chainId} AND s.prepaid_address = ${key.prepaid} AND s.usdc_address = ${key.usdc}
          AND p.id IN ${sql(batch.ids)} AND p.claim_token = ${batch.claimToken} AND p.worker_id = ${`user:${owner}`}
          AND p.status = 'leased' AND p.lease_until > now() RETURNING p.id`;
        if (updated.length !== batch.ids.length) throw new Error("Batch claim expired or changed before journaling");
        await sql`INSERT INTO prepaid_relayer_transactions(transaction_hash,chain_id,prepaid_address,executor,nonce,claim_token,payment_ids,signed_transaction)
          VALUES (${hash},${key.chainId},${key.prepaid},${owner},${String(nonce)},${batch.claimToken},${sql.array(batch.ids, 2950)},${raw})`;
      });
      return { hash, raw, claimToken: batch.claimToken, nonce: String(nonce), prepaid: key.prepaid };
    },
    async confirm(hash: Hex) { await db`UPDATE prepaid_relayer_transactions SET confirmed = true WHERE transaction_hash = ${hash}`; },
  };
}
