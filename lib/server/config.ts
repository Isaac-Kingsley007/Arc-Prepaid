import "server-only";
import { createPublicClient, http, parseAbi } from "viem";
import { ARC_USDC, normalizeContext, PAYMENT_NONCE_TYPEHASH, usdcDomainSeparator } from "../db/authorization";
import { ApiError } from "./http";
import { prepaidAbi } from "../prepaid";
import deployment from "../../deployments/arc-testnet.json";

export function paymentContext() {
  const prepaid = process.env.PREPAID_CONTRACT_ADDRESS || deployment.contractAddress;
  if (!prepaid) throw new ApiError("Set PREPAID_CONTRACT_ADDRESS to the current PrePaid deployment.", 503);
  try { return normalizeContext({ chainId: 5042002, prepaid: prepaid as `0x${string}`, usdc: ARC_USDC }); }
  catch { throw new ApiError("Invalid PREPAID_CONTRACT_ADDRESS.", 503); }
}
export function arcClient() {
  return createPublicClient({ transport: http(process.env.ARC_RPC_URL || "https://rpc.testnet.arc.io", { timeout: 15_000, retryCount: 1 }) });
}
const usdcAbi = parseAbi(["function DOMAIN_SEPARATOR() view returns (bytes32)", "function decimals() view returns (uint8)"]);
export async function checkedContext() {
  const context = paymentContext(), client = arcClient();
  const [chainId, typehash, token, percent, domain, decimals] = await Promise.all([
    client.getChainId(),
    client.readContract({ address: context.prepaid, abi: prepaidAbi, functionName: "PAYMENT_NONCE_TYPEHASH" }),
    client.readContract({ address: context.prepaid, abi: prepaidAbi, functionName: "usdc" }),
    client.readContract({ address: context.prepaid, abi: prepaidAbi, functionName: "RELAYER_TIP_PERCENT" }),
    client.readContract({ address: context.usdc, abi: usdcAbi, functionName: "DOMAIN_SEPARATOR" }),
    client.readContract({ address: context.usdc, abi: usdcAbi, functionName: "decimals" }),
  ]);
  if (chainId !== context.chainId || typehash !== PAYMENT_NONCE_TYPEHASH || token.toLowerCase() !== context.usdc
    || percent !== BigInt(70) || decimals !== 6
    || domain !== usdcDomainSeparator(chainId)) {
    throw new ApiError("The configured contract or USDC signing domain is incompatible. Use the current PrePaid deployment on Arc testnet.", 503);
  }
  return context;
}
export async function isCancelled(payer: `0x${string}`, scheduleId: `0x${string}`) {
  return arcClient().readContract({ address: paymentContext().prepaid, abi: prepaidAbi, functionName: "cancelledSchedules", args: [payer, scheduleId] });
}
