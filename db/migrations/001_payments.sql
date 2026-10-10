-- Exact uint256 values, without NUMERIC scale rounding or JavaScript float conversion.
CREATE DOMAIN prepaid_uint256 AS numeric
  CHECK (VALUE >= 0 AND VALUE = trunc(VALUE)
    AND VALUE <= 115792089237316195423570985008687907853269984665640564039457584007913129639935);
CREATE DOMAIN prepaid_address AS text CHECK (VALUE ~ '^0x[0-9a-f]{40}$');
CREATE DOMAIN prepaid_bytes32 AS text CHECK (VALUE ~ '^0x[0-9a-f]{64}$');

CREATE TABLE prepaid_schedules (
  id uuid PRIMARY KEY,
  chain_id bigint NOT NULL CHECK (chain_id IN (5042002, 5042)),
  prepaid_address prepaid_address NOT NULL,
  usdc_address prepaid_address NOT NULL CHECK (usdc_address = '0x3600000000000000000000000000000000000000'),
  payer prepaid_address NOT NULL CHECK (payer <> '0x0000000000000000000000000000000000000000'),
  schedule_id prepaid_bytes32 NOT NULL CHECK (schedule_id <> '0x0000000000000000000000000000000000000000000000000000000000000000'),
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 120),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  cancellation_tx_hash prepaid_bytes32,
  cancellation_block_number prepaid_uint256,
  cancellation_block_hash prepaid_bytes32,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, prepaid_address, payer, schedule_id),
  CHECK (prepaid_address <> '0x0000000000000000000000000000000000000000' AND prepaid_address <> usdc_address),
  CHECK ((cancellation_tx_hash IS NULL AND cancellation_block_number IS NULL AND cancellation_block_hash IS NULL)
    OR (cancellation_tx_hash IS NOT NULL AND cancellation_block_number IS NOT NULL AND cancellation_block_hash IS NOT NULL))
);

CREATE TABLE prepaid_payments (
  id uuid PRIMARY KEY,
  schedule_pk uuid NOT NULL REFERENCES prepaid_schedules(id),
  occurrence integer NOT NULL CHECK (occurrence >= 0),
  payee prepaid_address NOT NULL CHECK (payee <> '0x0000000000000000000000000000000000000000'),
  amount prepaid_uint256 NOT NULL CHECK (amount > 0),
  tip prepaid_uint256 NOT NULL,
  valid_after prepaid_uint256 NOT NULL,
  valid_before prepaid_uint256 NOT NULL,
  salt prepaid_bytes32 NOT NULL,
  nonce prepaid_bytes32 NOT NULL UNIQUE,
  v smallint NOT NULL CHECK (v IN (27, 28)),
  r prepaid_bytes32 NOT NULL,
  s prepaid_bytes32 NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'submitted', 'executed', 'cancelled', 'expired', 'unavailable')),
  claim_token uuid,
  worker_id text CHECK (length(worker_id) <= 128),
  lease_until timestamptz,
  retry_after timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  transaction_hash prepaid_bytes32,
  executor prepaid_address,
  execution_block_number prepaid_uint256,
  execution_block_hash prepaid_bytes32,
  last_error text CHECK (length(last_error) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_pk, occurrence),
  UNIQUE (schedule_pk, salt),
  CHECK (valid_after < valid_before),
  CHECK (amount + tip <= 115792089237316195423570985008687907853269984665640564039457584007913129639935),
  CHECK ((status = 'leased' AND claim_token IS NOT NULL AND worker_id IS NOT NULL AND lease_until IS NOT NULL)
    OR (status <> 'leased' AND lease_until IS NULL)),
  CHECK (status <> 'submitted' OR (claim_token IS NOT NULL AND transaction_hash IS NOT NULL AND executor IS NOT NULL)),
  CHECK (status <> 'executed' OR (transaction_hash IS NOT NULL AND executor IS NOT NULL
    AND execution_block_number IS NOT NULL AND execution_block_hash IS NOT NULL))
);

CREATE INDEX prepaid_schedules_payer ON prepaid_schedules(chain_id, prepaid_address, payer, created_at DESC, id);
CREATE INDEX prepaid_payments_due ON prepaid_payments(valid_after, valid_before, retry_after)
  WHERE status IN ('pending', 'leased');
CREATE INDEX prepaid_payments_submitted ON prepaid_payments(updated_at, id) WHERE status = 'submitted';
