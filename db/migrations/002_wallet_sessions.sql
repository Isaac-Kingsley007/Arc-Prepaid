-- Opaque, hashed tokens: a five-minute, single-use sign-in challenge becomes
-- an eight-hour session only after proving ownership of its wallet.
CREATE TABLE prepaid_wallet_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  payer prepaid_address NOT NULL,
  message text NOT NULL,
  origin text NOT NULL,
  authenticated boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL
);
CREATE INDEX prepaid_wallet_sessions_expiry ON prepaid_wallet_sessions(expires_at);
