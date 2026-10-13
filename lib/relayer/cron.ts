import "server-only";
import { formatUnits, type Address, type Hex } from "viem";
import { createPaymentRepository } from "../db/payments";
import { claimBatch, discover, reconcile } from "./service";
import { createTransactionJournal, type JournalTransaction } from "./journal";
import { allowedBatch, type cronConfig } from "./cron-config";
import type { ChainContext } from "../db/authorization";

type Client = Parameters<typeof reconcile>[3];
type Repo = ReturnType<typeof createPaymentRepository>;
type Journal = ReturnType<typeof createTransactionJournal>;
export async function recoverTransaction(tx: JournalTransaction, context: ChainContext, executor: Address,
  repo: Repo, journal: Journal, client: Client, broadcast: (raw: Hex) => Promise<Hex>, log: (message: string) => void) {
  const originalContext = { ...context, prepaid: tx.prepaid };
  try {
    const result = await reconcile(originalContext, tx.hash, repo, client, executor, tx.claimToken);
    if (!result.pending) { await journal.confirm(tx.hash); log(`Confirmed ${tx.hash}: ${result.executed} executed, ${result.failed} failed, ${formatUnits(BigInt(result.reward), 6)} USDC tips.`); return true; }
  } catch { /* It may not have reached the RPC; only the identical signed bytes may be retried. */ }
  const nonce = await client.getTransactionCount({ address: executor, blockTag: "latest" });
  if (BigInt(nonce) > BigInt(tx.nonce)) throw new Error("An unresolved relayer nonce was consumed by another transaction. Recover its receipt before continuing");
  try { await broadcast(tx.raw); } catch { /* Already-known, timeout and transport failures all retain the journal entry. */ }
  try { await client.waitForTransactionReceipt({ hash: tx.hash, confirmations: 1, timeout: 60_000 }); } catch { /* Leave it reserved for the next run. */ }
  try {
    const result = await reconcile(originalContext, tx.hash, repo, client, executor, tx.claimToken);
    if (!result.pending) { await journal.confirm(tx.hash); log(`Confirmed ${tx.hash}: ${result.executed} executed, ${result.failed} failed, ${formatUnits(BigInt(result.reward), 6)} USDC tips.`); return true; }
  } catch { /* Never interpret RPC uncertainty as a failed payment. */ }
  log(`Receipt pending for ${tx.hash}; saved for recovery. No new batch will be sent.`);
  return false;
}

export async function runCron(options: { context: ChainContext; executor: Address; client: Client; repo: Repo; journal: Journal;
  config: ReturnType<typeof cronConfig>; dryRun: boolean; sign?: (batch: Awaited<ReturnType<typeof claimBatch>>) => Promise<Hex>;
  broadcast: (raw: Hex) => Promise<Hex>; log: (message: string) => void }) {
  const { context, executor, client, repo, journal, config, log } = options;
  if (!options.dryRun) {
    for (const tx of await journal.pending(context, executor)) {
      if (!await recoverTransaction(tx, context, executor, repo, journal, client, options.broadcast, log)) return;
    }
    for (const hash of [...new Set((await repo.listSubmittedPayments(context, 100)).map((p) => p.transactionHash!))].slice(0, 10)) {
      try { await reconcile(context, hash, repo, client); } catch { /* Preserve unresolved user relayer submissions. */ }
      finally { await repo.touchSubmittedHash(context, hash); }
    }
  }
  if (options.dryRun) {
    // No claims, expiry writes, journal writes, signing or broadcasting in dry-run mode.
    const block = await client.getBlock();
    const rows = await repo.listDuePayments(context, block.timestamp.toString(), 50);
    const { checkPayments } = await import("./service");
    const eligible = (await checkPayments(rows, context, client)).filter((p) => !p.reason);
    log(`Dry run: ${eligible.length} executable candidates. No transactions signed or sent.`);
    return;
  }
  const candidates = await discover(context, repo, client);
  if (!candidates.some((p) => p.eligible)) { log("No executable payments right now."); return; }
  for (let i = 0; i < config.maxBatches; i++) {
    const block = await client.getBlock();
    if (!(await repo.listDuePayments(context, block.timestamp.toString(), 1)).length) { log("No more due payments."); break; }
    const batch = await claimBatch(context, executor, config.batchSize, repo, client);
    if (!allowedBatch(batch.reward, batch.estimatedCost, config)) {
      await repo.releaseClaims(batch.claimToken, "Cron gas budget or profitability policy rejected the batch");
      log("Skipped batch: gas budget or profitability policy not satisfied."); break;
    }
    let saved = false;
    try {
      const raw = await options.sign!(batch);
      const tx = await journal.save(batch, executor, raw);
      saved = true;
      log(`Stored ${tx.hash} before broadcast (${batch.payments.length} payments).`);
      if (!await recoverTransaction(tx, context, executor, repo, journal, client, options.broadcast, log)) return;
    } catch (error) {
      if (!saved) await repo.releaseClaims(batch.claimToken, "Cron stopped before committing a transaction");
      throw error;
    }
  }
}
