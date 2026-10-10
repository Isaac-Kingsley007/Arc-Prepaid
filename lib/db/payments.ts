import "server-only";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { getDatabase, type Database } from "./client";
import {
  bytes32, normalizeAddress, normalizeContext, normalizePayment, normalizeScheduleKey,
  uint256, verifyPaymentSignature, type ChainContext, type ScheduleKey, type SignedPayment,
} from "./authorization";
import type { Address, Hex } from "viem";

export type PaymentStatus = "pending" | "leased" | "submitted" | "executed" | "cancelled" | "expired" | "unavailable";
export type Metadata = { [key: string]: postgres.JSONValue };
export type PaymentRecord = ScheduleKey & SignedPayment & {
  id: string; occurrence: number; nonce: Hex; status: PaymentStatus;
  claimToken: string | null; workerId: string | null; leaseUntil: Date | null;
  transactionHash: Hex | null; executor: Address | null;
  executionBlockNumber: string | null; executionBlockHash: Hex | null;
  attemptCount: number; lastError: string | null; createdAt: Date; updatedAt: Date;
};
export type ScheduleRecord = ScheduleKey & {
  id: string; label: string; metadata: Metadata; createdAt: Date;
  cancellationTxHash: Hex | null; cancellationBlockNumber: string | null; cancellationBlockHash: Hex | null;
};
type ScheduleRow = {
  id: string; chain_id: string; prepaid_address: Address; usdc_address: Address;
  payer: Address; schedule_id: Hex; label: string; metadata: Metadata; created_at: Date;
  cancellation_tx_hash: Hex | null; cancellation_block_number: string | null; cancellation_block_hash: Hex | null;
};
type PaymentRow = {
  id: string; chain_id: string; prepaid_address: Address; usdc_address: Address;
  payer: Address; schedule_id: Hex; occurrence: number; nonce: Hex; payee: Address;
  amount: string; tip: string; valid_after: string; valid_before: string; salt: Hex;
  v: number; r: Hex; s: Hex; status: PaymentStatus; claim_token: string | null;
  worker_id: string | null; lease_until: Date | null; transaction_hash: Hex | null;
  executor: Address | null; execution_block_number: string | null; execution_block_hash: Hex | null;
  attempt_count: number; last_error: string | null; created_at: Date; updated_at: Date;
};
function paymentRecord(row: PaymentRow): PaymentRecord {
  return {
    id: row.id, chainId: Number(row.chain_id), prepaid: row.prepaid_address, usdc: row.usdc_address,
    payer: row.payer, scheduleId: row.schedule_id, occurrence: row.occurrence, nonce: row.nonce,
    payee: row.payee, amount: row.amount, tip: row.tip, validAfter: row.valid_after, validBefore: row.valid_before,
    salt: row.salt, v: row.v, r: row.r, s: row.s, status: row.status,
    claimToken: row.claim_token, workerId: row.worker_id, leaseUntil: row.lease_until,
    transactionHash: row.transaction_hash, executor: row.executor,
    executionBlockNumber: row.execution_block_number, executionBlockHash: row.execution_block_hash,
    attemptCount: row.attempt_count, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function scheduleRecord(row: ScheduleRow): ScheduleRecord {
  return { id: row.id, chainId: Number(row.chain_id), prepaid: row.prepaid_address, usdc: row.usdc_address,
    payer: row.payer, scheduleId: row.schedule_id, label: row.label, metadata: row.metadata, createdAt: row.created_at,
    cancellationTxHash: row.cancellation_tx_hash, cancellationBlockNumber: row.cancellation_block_number,
    cancellationBlockHash: row.cancellation_block_hash };
}
function bounded(value: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be between 1 and ${max}`);
  return value;
}
function uuid(value: string): string {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new Error("Expected a UUID");
  return value;
}
function safeError(message: string): string {
  // Callers should pass short classified messages, not driver errors or secrets.
  return message.slice(0, 2000);
}

/** Trusted server-side repository. It does not authenticate HTTP callers or submit chain transactions. */
export function createPaymentRepository(db: Database = getDatabase()) {
  const contextColumns = db`s.chain_id, s.prepaid_address, s.usdc_address, s.payer, s.schedule_id`;
  const contextFilter = (context: ChainContext) => db`s.chain_id = ${context.chainId}
    AND s.prepaid_address = ${context.prepaid} AND s.usdc_address = ${context.usdc}`;
  const keyFilter = (key: ScheduleKey) => db`${contextFilter(key)} AND s.payer = ${key.payer} AND s.schedule_id = ${key.scheduleId}`;

  return {
    /** Atomic and idempotent for the same ordered payment set. Signed instructions are immutable. */
    async saveSchedule(input: ScheduleKey & { payments: SignedPayment[]; label?: string; metadata?: Metadata }): Promise<ScheduleRecord> {
      const key = normalizeScheduleKey(input);
      bounded(input.payments.length, 50, "Schedule payment count");
      const label = input.label ?? "", metadata = input.metadata ?? {};
      if (label.length > 120 || metadata === null || typeof metadata !== "object" || Array.isArray(metadata)
        || JSON.stringify(metadata).length > 16_384) throw new Error("Invalid schedule label/metadata");
      const payments = input.payments.map((payment) => normalizePayment(key, payment));
      if (new Set(payments.map((payment) => payment.salt)).size !== payments.length) throw new Error("Every occurrence needs a unique salt");
      // Verify before opening a transaction; invalid/tampered uploads never become searchable work.
      const nonces = await Promise.all(payments.map((payment) => verifyPaymentSignature(key, payment)));
      return db.begin(async (tx) => {
        await tx`INSERT INTO prepaid_schedules(id, chain_id, prepaid_address, usdc_address, payer, schedule_id, label, metadata)
          VALUES (${randomUUID()}, ${key.chainId}, ${key.prepaid}, ${key.usdc}, ${key.payer}, ${key.scheduleId}, ${label}, ${tx.json(metadata)})
          ON CONFLICT (chain_id, prepaid_address, payer, schedule_id) DO NOTHING`;
        const [schedule] = await tx<ScheduleRow[]>`SELECT s.* FROM prepaid_schedules s WHERE ${keyFilter(key)} FOR UPDATE`;
        const existing = await tx<PaymentRow[]>`SELECT p.*, ${contextColumns} FROM prepaid_payments p
          JOIN prepaid_schedules s ON s.id = p.schedule_pk WHERE s.id = ${schedule.id} ORDER BY p.occurrence`;
        if (existing.length) {
          if (existing.length !== payments.length || existing.some((row, index) => row.nonce !== nonces[index])) {
            throw new Error("Schedule ID already belongs to different immutable payment instructions");
          }
          return scheduleRecord(schedule);
        }
        if (schedule.cancellation_tx_hash) throw new Error("Cannot add payments to a cancelled schedule");
        for (let i = 0; i < payments.length; i++) {
          const p = payments[i];
          await tx`INSERT INTO prepaid_payments(id, schedule_pk, occurrence, payee, amount, tip, valid_after, valid_before, salt, nonce, v, r, s)
            VALUES (${randomUUID()}, ${schedule.id}, ${i}, ${p.payee}, ${p.amount}, ${p.tip}, ${p.validAfter}, ${p.validBefore},
              ${p.salt}, ${nonces[i]}, ${p.v}, ${p.r}, ${p.s})`;
        }
        return scheduleRecord(schedule);
      });
    },

    async getSchedule(keyInput: ScheduleKey): Promise<ScheduleRecord | null> {
      const key = normalizeScheduleKey(keyInput);
      const [row] = await db<ScheduleRow[]>`SELECT s.* FROM prepaid_schedules s WHERE ${keyFilter(key)}`;
      return row ? scheduleRecord(row) : null;
    },

    async listPayerSchedules(contextInput: ChainContext, payerInput: Address, limit = 50, offset = 0): Promise<ScheduleRecord[]> {
      const context = normalizeContext(contextInput), payer = normalizeAddress(payerInput);
      bounded(limit, 100, "Limit");
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
      const rows = await db<ScheduleRow[]>`SELECT s.* FROM prepaid_schedules s WHERE ${contextFilter(context)} AND s.payer = ${payer}
        ORDER BY s.created_at DESC, s.id LIMIT ${limit} OFFSET ${offset}`;
      return rows.map(scheduleRecord);
    },

    async listSchedulePayments(keyInput: ScheduleKey): Promise<PaymentRecord[]> {
      const key = normalizeScheduleKey(keyInput);
      const rows = await db<PaymentRow[]>`SELECT p.*, ${contextColumns} FROM prepaid_payments p
        JOIN prepaid_schedules s ON s.id = p.schedule_pk WHERE ${keyFilter(key)} ORDER BY p.occurrence`;
      return rows.map(paymentRecord);
    },

    /** Read-only discovery for a relayer page. The timestamp must come from the latest chain block. */
    async listDuePayments(contextInput: ChainContext, chainTimestamp: string, limit = 50): Promise<PaymentRecord[]> {
      const context = normalizeContext(contextInput), timestamp = uint256(chainTimestamp);
      bounded(limit, 50, "Batch size");
      const rows = await db<PaymentRow[]>`SELECT p.*, ${contextColumns} FROM prepaid_payments p
        JOIN prepaid_schedules s ON s.id = p.schedule_pk WHERE ${contextFilter(context)}
        AND s.cancellation_tx_hash IS NULL AND p.valid_after < ${timestamp}::numeric AND p.valid_before > ${timestamp}::numeric
        AND p.retry_after <= now() AND (p.status = 'pending' OR (p.status = 'leased' AND p.lease_until <= now()))
        ORDER BY p.valid_before, p.valid_after, p.id LIMIT ${limit}`;
      return rows.map(paymentRecord);
    },

    /** Atomic claim using SKIP LOCKED; locks last only for this SQL statement, never an RPC call. */
    async claimDuePayments(contextInput: ChainContext, chainTimestamp: string, workerId: string, limit = 50, leaseSeconds = 120) {
      const context = normalizeContext(contextInput), timestamp = uint256(chainTimestamp);
      bounded(limit, 50, "Batch size"); bounded(leaseSeconds, 600, "Lease duration");
      if (!workerId || workerId.length > 128) throw new Error("Invalid worker ID");
      const claimToken = randomUUID();
      const rows = await db<PaymentRow[]>`WITH picked AS (
        SELECT p.id FROM prepaid_payments p JOIN prepaid_schedules s ON s.id = p.schedule_pk
        WHERE ${contextFilter(context)} AND s.cancellation_tx_hash IS NULL
        AND p.valid_after < ${timestamp}::numeric AND p.valid_before > ${timestamp}::numeric
        AND p.retry_after <= now() AND (p.status = 'pending' OR (p.status = 'leased' AND p.lease_until <= now()))
        ORDER BY p.valid_before, p.valid_after, p.id LIMIT ${limit} FOR UPDATE OF p SKIP LOCKED
      ), claimed AS (
        UPDATE prepaid_payments p SET status = 'leased', claim_token = ${claimToken}, worker_id = ${workerId},
          lease_until = now() + ${leaseSeconds} * interval '1 second', attempt_count = p.attempt_count + 1,
          transaction_hash = NULL, executor = NULL, updated_at = now()
        FROM picked WHERE p.id = picked.id RETURNING p.*
      ) SELECT p.*, ${contextColumns} FROM claimed p JOIN prepaid_schedules s ON s.id = p.schedule_pk
        ORDER BY p.valid_before, p.valid_after, p.id`;
      return { claimToken, payments: rows.map(paymentRecord) };
    },

    /** Save a known transaction hash before broadcast when possible. Submitted work never expires as a lease. */
    async recordSubmission(ids: string[], claimTokenInput: string, transactionHashInput: Hex, executorInput: Address): Promise<void> {
      bounded(ids.length, 50, "Submission count"); ids.forEach(uuid);
      if (new Set(ids).size !== ids.length) throw new Error("Duplicate payment IDs");
      const claimToken = uuid(claimTokenInput), hash = bytes32(transactionHashInput), executor = normalizeAddress(executorInput);
      await db.begin(async (tx) => {
        const rows = await tx`UPDATE prepaid_payments p SET status = 'submitted', transaction_hash = ${hash},
          executor = ${executor}, lease_until = NULL, updated_at = now()
          WHERE p.id IN ${tx(ids)} AND p.claim_token = ${claimToken}
          AND ((p.status = 'leased' AND p.lease_until > now()) OR (p.status = 'submitted' AND p.transaction_hash = ${hash} AND p.executor = ${executor}))
          RETURNING p.id`;
        if (rows.length !== ids.length) throw new Error("Claim expired or changed; submission was not recorded");
      });
    },

    /** Only release work that has not been submitted. RPC uncertainty must retain submitted status. */
    async releaseClaims(claimTokenInput: string, message: string, retrySeconds = 30): Promise<number> {
      const token = uuid(claimTokenInput); bounded(retrySeconds, 3600, "Retry delay");
      const rows = await db`UPDATE prepaid_payments SET status = 'pending', claim_token = NULL, worker_id = NULL,
        lease_until = NULL, last_error = ${safeError(message)}, retry_after = now() + ${retrySeconds} * interval '1 second', updated_at = now()
        WHERE claim_token = ${token} AND status = 'leased' RETURNING id`;
      return rows.length;
    },

    async listSubmittedPayments(contextInput: ChainContext, limit = 100): Promise<PaymentRecord[]> {
      const context = normalizeContext(contextInput); bounded(limit, 100, "Limit");
      const rows = await db<PaymentRow[]>`SELECT p.*, ${contextColumns} FROM prepaid_payments p
        JOIN prepaid_schedules s ON s.id = p.schedule_pk WHERE ${contextFilter(context)} AND p.status = 'submitted'
        ORDER BY p.updated_at, p.id LIMIT ${limit}`;
      return rows.map(paymentRecord);
    },

    /** Trusted confirmed PaymentExecuted event only; supersedes stale DB cancellation/expiry flags. */
    async recordExecution(contextInput: ChainContext, input: {
      payer: Address; nonce: Hex; transactionHash: Hex; executor: Address; blockNumber: string; blockHash: Hex;
    }): Promise<boolean> {
      const context = normalizeContext(contextInput), payer = normalizeAddress(input.payer), nonce = bytes32(input.nonce);
      const hash = bytes32(input.transactionHash), executor = normalizeAddress(input.executor);
      const block = uint256(input.blockNumber), blockHash = bytes32(input.blockHash);
      const rows = await db`UPDATE prepaid_payments p SET status = 'executed', transaction_hash = ${hash}, executor = ${executor},
        execution_block_number = ${block}, execution_block_hash = ${blockHash}, claim_token = NULL, worker_id = NULL,
        lease_until = NULL, last_error = NULL, updated_at = now()
        FROM prepaid_schedules s WHERE p.schedule_pk = s.id AND ${contextFilter(context)} AND s.payer = ${payer} AND p.nonce = ${nonce}
        AND (p.status <> 'executed' OR (p.transaction_hash = ${hash} AND p.execution_block_hash = ${blockHash}
          AND p.execution_block_number = ${block}::numeric AND p.executor = ${executor})) RETURNING p.id`;
      return rows.length === 1;
    },

    /** Confirmed PaymentFailed or reverted receipt only. Unknown RPC/broadcast outcomes do not belong here. */
    async recordSubmissionFailure(idInput: string, claimTokenInput: string, hashInput: Hex, message: string, retrySeconds = 30): Promise<boolean> {
      const id = uuid(idInput), token = uuid(claimTokenInput), hash = bytes32(hashInput);
      bounded(retrySeconds, 3600, "Retry delay");
      const rows = await db`UPDATE prepaid_payments p SET status = CASE WHEN s.cancellation_tx_hash IS NULL THEN 'pending' ELSE 'cancelled' END,
        claim_token = NULL, worker_id = NULL, lease_until = NULL, last_error = ${safeError(message)},
        retry_after = now() + ${retrySeconds} * interval '1 second', updated_at = now()
        FROM prepaid_schedules s WHERE p.schedule_pk = s.id AND p.id = ${id} AND p.status = 'submitted'
        AND p.claim_token = ${token} AND p.transaction_hash = ${hash} RETURNING p.id`;
      return rows.length === 1;
    },

    /** Trusted confirmed ScheduleCancellation event only. This does NOT cancel anything on-chain. */
    async recordScheduleCancellation(keyInput: ScheduleKey, event: { transactionHash: Hex; blockNumber: string; blockHash: Hex }): Promise<boolean> {
      const key = normalizeScheduleKey(keyInput), hash = bytes32(event.transactionHash);
      const block = uint256(event.blockNumber), blockHash = bytes32(event.blockHash);
      return db.begin(async (tx) => {
        const rows = await tx`UPDATE prepaid_schedules s SET cancellation_tx_hash = ${hash},
          cancellation_block_number = ${block}, cancellation_block_hash = ${blockHash}
          WHERE ${keyFilter(key)} AND (s.cancellation_tx_hash IS NULL OR (s.cancellation_tx_hash = ${hash}
            AND s.cancellation_block_number = ${block}::numeric AND s.cancellation_block_hash = ${blockHash})) RETURNING s.id`;
        if (!rows.length) return false;
        await tx`UPDATE prepaid_payments SET status = 'cancelled', claim_token = NULL, worker_id = NULL,
          lease_until = NULL, updated_at = now() WHERE schedule_pk = ${rows[0].id} AND status IN ('pending', 'leased')`;
        // Submitted items stay available for receipt reconciliation; an earlier transaction may have executed.
        return true;
      });
    },

    /** Used/revoked USDC nonce with no known execution event. Reconcile logs before invoking. */
    async recordAuthorizationUnavailable(contextInput: ChainContext, payerInput: Address, nonceInput: Hex): Promise<boolean> {
      const context = normalizeContext(contextInput), payer = normalizeAddress(payerInput), nonce = bytes32(nonceInput);
      const rows = await db`UPDATE prepaid_payments p SET status = 'unavailable', claim_token = NULL,
        worker_id = NULL, lease_until = NULL, updated_at = now()
        FROM prepaid_schedules s WHERE p.schedule_pk = s.id AND ${contextFilter(context)} AND s.payer = ${payer}
        AND p.nonce = ${nonce} AND p.status IN ('pending', 'leased') RETURNING p.id`;
      return rows.length === 1;
    },

    async expirePayments(contextInput: ChainContext, chainTimestamp: string): Promise<number> {
      const context = normalizeContext(contextInput), timestamp = uint256(chainTimestamp);
      const rows = await db`UPDATE prepaid_payments p SET status = 'expired', claim_token = NULL,
        worker_id = NULL, lease_until = NULL, updated_at = now()
        FROM prepaid_schedules s WHERE p.schedule_pk = s.id AND ${contextFilter(context)}
        AND p.valid_before <= ${timestamp}::numeric AND p.status IN ('pending', 'leased') RETURNING p.id`;
      return rows.length;
    },
  };
}
