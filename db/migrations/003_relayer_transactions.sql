-- Persist a signed transaction BEFORE broadcasting. A restarted runner can
-- rebroadcast the exact bytes/hash, rather than spend gas with another nonce.
CREATE TABLE prepaid_relayer_transactions (
  transaction_hash prepaid_bytes32 PRIMARY KEY,
  chain_id bigint NOT NULL CHECK (chain_id IN (5042002, 5042)),
  prepaid_address prepaid_address NOT NULL,
  executor prepaid_address NOT NULL,
  nonce prepaid_uint256 NOT NULL,
  claim_token uuid NOT NULL,
  payment_ids uuid[] NOT NULL CHECK (cardinality(payment_ids) BETWEEN 1 AND 50),
  signed_transaction text NOT NULL CHECK (signed_transaction ~ '^0x[0-9a-f]+$'),
  confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, executor, nonce)
);
CREATE INDEX prepaid_relayer_transactions_pending ON prepaid_relayer_transactions(chain_id, executor, nonce)
  WHERE NOT confirmed;
