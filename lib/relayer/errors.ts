/** Only fixed, approved diagnostics are printed; arbitrary error messages may contain secrets. */
export function relayerDiagnostic(error: unknown, stage: string): string {
  const known = new Set([
    "Invalid RELAYER_PRIVATE_KEY", "Set RELAYER_PRIVATE_KEY for execution",
    "Set RELAYER_ADDRESS for a dry run without a private key", "Relayer address does not match the private key",
    "Use --dry-run, --execute, or --recover ORIGINAL_HASH REPLACEMENT_HASH", "Gas budget must be above zero",
    ...["RELAYER_BATCH_SIZE", "RELAYER_MAX_BATCHES", "RELAYER_MAX_GAS_COST_USDC", "RELAYER_ALLOW_UNPROFITABLE", "RELAYER_MAX_LOSS_USDC", "RELAYER_MIN_PROFIT_USDC"].map((name) => `Invalid ${name}`),
  ]);
  if (error instanceof Error && known.has(error.message)) {
    if (error.message === "Invalid RELAYER_PRIVATE_KEY") return "Invalid RELAYER_PRIVATE_KEY: use 0x followed by exactly 64 hexadecimal characters (66 characters total).";
    return error.message;
  }
  const visited = new Set<unknown>();
  let cause: unknown = error;
  while (cause && typeof cause === "object" && !visited.has(cause)) {
    visited.add(cause);
    const item = cause as { code?: unknown; cause?: unknown };
    if (["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED"].includes(String(item.code))) return `Certificate verification failed during ${stage}. Check the trusted certificate store; keep TLS verification enabled.`;
    if (item.code === "42P01") return "Database tables are missing. Run the database migration against this relayer's DATABASE_URL.";
    if (item.code === "28P01") return "Database authentication failed. Check DATABASE_URL credentials.";
    cause = item.cause;
  }
  return `Failure during ${stage}. Check the corresponding configuration and connection. Raw error details were withheld to protect credentials.`;
}
