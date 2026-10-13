import { getAddress, parseUnits, type Address } from "viem";

function integer(value: string | undefined, fallback: number, max: number, name: string) {
  const n = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${name}`);
  return n;
}
function amount(value: string | undefined, fallback: string, name: string) {
  const text = value || fallback;
  if (!/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,6})?$/.test(text)) throw new Error(`Invalid ${name}`);
  return parseUnits(text, 18);
}
export function cronConfig(env: Record<string, string | undefined> = process.env) {
  const maxGasCost = amount(env.RELAYER_MAX_GAS_COST_USDC, "0.10", "RELAYER_MAX_GAS_COST_USDC");
  if (maxGasCost === BigInt(0)) throw new Error("Gas budget must be above zero");
  if (env.RELAYER_ALLOW_UNPROFITABLE && !["true", "false"].includes(env.RELAYER_ALLOW_UNPROFITABLE)) throw new Error("Invalid RELAYER_ALLOW_UNPROFITABLE");
  return { batchSize: integer(env.RELAYER_BATCH_SIZE, 5, 10, "RELAYER_BATCH_SIZE"),
    maxBatches: integer(env.RELAYER_MAX_BATCHES, 3, 20, "RELAYER_MAX_BATCHES"), maxGasCost,
    minProfit: amount(env.RELAYER_MIN_PROFIT_USDC, "0", "RELAYER_MIN_PROFIT_USDC"),
    maxLoss: amount(env.RELAYER_MAX_LOSS_USDC, "0.02", "RELAYER_MAX_LOSS_USDC"),
    allowUnprofitable: env.RELAYER_ALLOW_UNPROFITABLE !== "false" };
}
export function allowedBatch(reward: string, gasCost: string, config: ReturnType<typeof cronConfig>) {
  const cost = BigInt(gasCost), tips = BigInt(reward) * BigInt(1000000000000);
  return cost <= config.maxGasCost && (config.allowUnprofitable ? cost - tips <= config.maxLoss : tips - cost >= config.minProfit);
}
export function configuredAddress(value: string | undefined): Address {
  if (!value) throw new Error("Set RELAYER_ADDRESS for a dry run without a private key");
  return getAddress(value);
}
