import { createWalletClient, defineChain, encodeFunctionData, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { closeDatabase, getDatabase } from "../lib/db/client";
import { createPaymentRepository } from "../lib/db/payments";
import { bytes32, normalizeAddress, toContractPayment } from "../lib/db/authorization";
import { prepaidAbi } from "../lib/prepaid";
import { arcClient, checkedContext } from "../lib/server/config";
import { configuredAddress, cronConfig } from "../lib/relayer/cron-config";
import { createTransactionJournal } from "../lib/relayer/journal";
import { runCron } from "../lib/relayer/cron";
import { settleReplacement } from "../lib/relayer/service";

async function main() {
  const args = process.argv.slice(2);
  const recovery = args.length === 3 && args[0] === "--recover";
  if (!recovery && (args.length > 1 || args.some((arg) => !["--dry-run", "--execute"].includes(arg)))) throw new Error("Use --dry-run, --execute, or --recover ORIGINAL_HASH REPLACEMENT_HASH");
  const dryRun = args[0] !== "--execute", config = cronConfig();
  const secret = process.env.RELAYER_PRIVATE_KEY;
  if (secret && !/^0x[0-9a-fA-F]{64}$/.test(secret)) throw new Error("Invalid RELAYER_PRIVATE_KEY");
  const account = secret ? privateKeyToAccount(secret as Hex) : undefined;
  if (!dryRun && !account) throw new Error("Set RELAYER_PRIVATE_KEY for execution");
  const executor = normalizeAddress(account?.address ?? configuredAddress(process.env.RELAYER_ADDRESS));
  if (account && process.env.RELAYER_ADDRESS && normalizeAddress(process.env.RELAYER_ADDRESS) !== executor) throw new Error("Relayer address does not match the private key");
  const context = await checkedContext(), client = arcClient(), db = getDatabase();
  if (recovery) {
    const journal = createTransactionJournal(db), original = bytes32(args[1]), replacement = bytes32(args[2]);
    const saved = (await journal.pending(context, executor)).find((tx) => tx.hash === original);
    if (!saved) throw new Error("Pending transaction not found for this relayer");
    const result = await settleReplacement({ ...context, prepaid: saved.prepaid }, original, replacement, executor, saved.claimToken, createPaymentRepository(db), client);
    await journal.confirm(original);
    console.log(`Verified replacement ${replacement}: ${result.executed} executed, ${result.failed} failed. Original journal entry resolved.`);
    return;
  }
  const chain = defineChain({ id: context.chainId, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [process.env.ARC_RPC_URL || "https://rpc.testnet.arc.io"] } } });
  const wallet = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0], { retryCount: 1, timeout: 15_000 }) });
  console.log(`${dryRun ? "Dry run" : "Execution"}: Arc testnet, relayer ${executor}, contract ${context.prepaid}.`);
  await runCron({ context, executor, client, repo: createPaymentRepository(db), journal: createTransactionJournal(db), config, dryRun,
    sign: async (batch) => {
      const data = encodeFunctionData({ abi: prepaidAbi, functionName: "executePayments",
        args: [batch.payments.map((p) => toContractPayment({ ...context, payer: p.payer, scheduleId: p.scheduleId }, p))] });
      const nonce = await client.getTransactionCount({ address: executor, blockTag: "pending" });
      return account!.signTransaction({ chainId: context.chainId, type: "eip1559", to: context.prepaid, data, value: BigInt(0), nonce,
        gas: BigInt(batch.gas), maxFeePerGas: BigInt(batch.maxFeePerGas), maxPriorityFeePerGas: BigInt(batch.maxPriorityFeePerGas) });
    },
    broadcast: (serializedTransaction) => wallet.sendRawTransaction({ serializedTransaction }), log: (message) => console.log(message),
  });
}
main().catch(() => {
  // Driver/RPC errors may contain URLs, SQL or raw signed transactions. Never log them.
  console.error("Relayer stopped. Check configuration, database migrations, wallet funding and pending transaction receipts. No secrets or signed transaction bytes were printed.");
  process.exitCode = 1;
}).finally(closeDatabase);
