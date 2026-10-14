import { defineChain } from "viem";

export function arcNetwork(value: string | undefined = "mainnet") {
  if (value !== "mainnet" && value !== "testnet") throw new Error("NEXT_PUBLIC_ARC_NETWORK must be mainnet or testnet");
  const testnet = value === "testnet";
  return defineChain({
    id: testnet ? 5042002 : 5042,
    name: testnet ? "Arc Testnet" : "Arc Mainnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [testnet ? "https://rpc.testnet.arc.io" : "https://rpc.mainnet.arc.io"] } },
    blockExplorers: { default: { name: "Arc Explorer", url: testnet ? "https://explorer.testnet.arc.io" : "https://explorer.arc.io" } },
    testnet,
  });
}

// Next.js embeds this public selector at build time. Rebuild after changing it.
export const arcChain = arcNetwork(process.env.NEXT_PUBLIC_ARC_NETWORK);
