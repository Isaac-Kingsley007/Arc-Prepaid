import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeDeployData,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

const USDC = "0x3600000000000000000000000000000000000000" as const;
const FEE_FLOOR = BigInt(20_000_000_000);
const tokenAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);
const prepaidAbi = parseAbi([
  "function owner() view returns (address)",
  "function usdc() view returns (address)",
]);

type Artifact = {
  contractName: string;
  inputSourceName: string;
  buildInfoId: string;
  abi: Abi;
  bytecode: Hex;
};
type BuildInfo = { solcLongVersion: string; input: unknown };

async function main() {
  const mode = process.argv[2];
  if ((mode !== "--check" && mode !== "--deploy") || process.argv.length !== 3) {
    throw new Error("Use pnpm contracts:check:testnet or pnpm contracts:deploy:testnet.");
  }
  const privateKey = process.env.ARC_TESTNET_PRIVATE_KEY;
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("Set ARC_TESTNET_PRIVATE_KEY in .env.testnet to the funded wallet's 0x-prefixed private key.");
  }
  // Do not include the key, or an error containing it, in any console output.
  let account;
  try { account = privateKeyToAccount(privateKey as Hex); }
  catch { throw new Error("ARC_TESTNET_PRIVATE_KEY is not a valid signing key."); }

  const rpcUrl = process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.io";
  const url = new URL(rpcUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("RPC URL must use HTTP(S).");
  const transport = http(rpcUrl, { timeout: 15_000, retryCount: 0 });
  const client = createPublicClient({ chain: arcTestnet, transport });
  const chainId = await client.getChainId();
  if (chainId !== 5042002) throw new Error(`Wrong network: expected Arc testnet (5042002), received ${chainId}. No transaction sent.`);

  const recordPath = resolve("deployments/arc-testnet.json");
  const inputPath = resolve("deployments/arc-testnet-input.json");
  if (mode === "--deploy" && existsSync(recordPath)) {
    throw new Error("deployments/arc-testnet.json already exists. Inspect its transaction on the explorer before attempting another deployment. Move the record aside only if you intentionally want a new contract.");
  }
  const artifact = JSON.parse(await readFile(new URL("../packages/contracts/artifacts/contracts/PrePaid.sol/PrePaid.json", import.meta.url), "utf8")) as Artifact;
  if (artifact.contractName !== "PrePaid" || !/^0x[0-9a-f]+$/i.test(artifact.bytecode)) {
    throw new Error("Invalid PrePaid artifact. Run pnpm contracts:build.");
  }
  const buildInfo = JSON.parse(await readFile(new URL(`../packages/contracts/artifacts/build-info/${artifact.buildInfoId}.json`, import.meta.url), "utf8")) as BuildInfo;
  const [balance, decimals, domainSeparator, gasPrice] = await Promise.all([
    client.getBalance({ address: account.address }),
    client.readContract({ address: USDC, abi: tokenAbi, functionName: "decimals" }),
    client.readContract({ address: USDC, abi: tokenAbi, functionName: "DOMAIN_SEPARATOR" }),
    client.getGasPrice(),
  ]);
  if (decimals !== 6 || /^0x0+$/.test(domainSeparator)) throw new Error("Unexpected Arc USDC interface. No transaction sent.");
  console.log("Network: Arc testnet (5042002)");
  console.log(`Deployer / initial owner: ${account.address}`);
  console.log(`Existing USDC: ${USDC}`);
  console.log(`Wallet balance: ${formatUnits(balance, 18)} USDC`);

  // All deployment gas accounting is native USDC (18 decimals), not ERC-20 units.
  const maxFeePerGas = gasPrice * BigInt(2) > FEE_FLOOR ? gasPrice * BigInt(2) : FEE_FLOOR;
  const maxPriorityFeePerGas = BigInt(0);
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [USDC] });
  const estimate = await client.estimateGas({ account, data, maxFeePerGas, maxPriorityFeePerGas });
  const gas = (estimate * BigInt(120) + BigInt(99)) / BigInt(100);
  const maximumCost = gas * maxFeePerGas;
  console.log(`Estimated deployment gas: ${estimate}; limit with 20% margin: ${gas}`);
  console.log(`Fee cap: ${formatUnits(maxFeePerGas, 9)} Gwei; maximum gas cost: ${formatUnits(maximumCost, 18)} USDC`);
  if (balance < maximumCost) throw new Error("The deployer wallet cannot cover the displayed maximum gas cost. No transaction sent.");
  if (mode === "--check") {
    console.log("Preflight passed. No transaction signed or sent.");
    return;
  }

  // Save exact compiler input before sending so source verification matches this deployment.
  await mkdir(resolve("deployments"), { recursive: true });
  await writeFile(inputPath, JSON.stringify(buildInfo.input, null, 2) + "\n");
  const wallet = createWalletClient({ account, chain: arcTestnet, transport });
  const hash = await wallet.deployContract({
    abi: artifact.abi, bytecode: artifact.bytecode, args: [USDC],
    gas, maxFeePerGas, maxPriorityFeePerGas,
  });
  console.log(`Deployment transaction: https://explorer.testnet.arc.io/tx/${hash}`);
  const record = {
    network: "arc-testnet", chainId, status: "pending", deployer: account.address,
    usdc: USDC, transactionHash: hash,
    compilerVersion: buildInfo.solcLongVersion,
    contract: `${artifact.inputSourceName}:PrePaid`,
    constructorArguments: encodeAbiParameters([{ type: "address" }], [USDC]),
  };
  // Keep the hash even if receipt waiting fails; do not blindly redeploy on a timeout.
  await writeFile(recordPath, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    await writeFile(recordPath, JSON.stringify({ ...record, status: "reverted" }, null, 2) + "\n");
    throw new Error("Deployment reverted. Inspect the saved transaction on the explorer.");
  }
  const address = receipt.contractAddress;
  // Persist the mined address before read-back checks, so an RPC issue cannot lose it.
  await writeFile(recordPath, JSON.stringify({
    ...record, status: "deployed", contractAddress: address,
    blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(),
    actualGasCostUSDC: formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18),
    explorerUrl: `https://explorer.testnet.arc.io/address/${address}`,
  }, null, 2) + "\n");
  console.log(`PrePaid deployed: ${address}`);
  const [owner, token, code] = await Promise.all([
    client.readContract({ address, abi: prepaidAbi, functionName: "owner" }),
    client.readContract({ address, abi: prepaidAbi, functionName: "usdc" }),
    client.getCode({ address }),
  ]);
  if (!code || code === "0x" || getAddress(owner) !== getAddress(account.address) || getAddress(token) !== getAddress(USDC)) {
    throw new Error("Deployment read-back did not match the expected owner, USDC, or bytecode. Inspect the saved deployment record.");
  }
  console.log("Verified onchain: deployed code, expected owner, and real Arc USDC.");
  console.log(`Deployment record: ${recordPath}`);
  console.log(`Source verification input: ${inputPath}`);
}

main().catch((error: unknown) => {
  let message = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : "Unknown deployment error";
  const key = process.env.ARC_TESTNET_PRIVATE_KEY;
  if (key) message = message.replaceAll(key, "[private key]");
  console.error(message.replace(/https?:\/\/\S+/g, "[RPC URL]"));
  console.error("If a transaction hash was printed or saved, check it on the explorer before rerunning deployment.");
  process.exitCode = 1;
});
