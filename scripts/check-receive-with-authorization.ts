import {
  createPublicClient,
  decodeErrorResult,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

// Arc's documented native USDC ERC-20 interface, on both networks.
// https://docs.arc.io/arc/references/contract-addresses
const USDC: Address = "0x3600000000000000000000000000000000000000";
const networks = {
  testnet: { chainId: 5042002, rpc: "https://rpc.testnet.arc.io" },
  mainnet: { chainId: 5042, rpc: "https://rpc.mainnet.arc.io" },
} as const;

const abi = parseAbi([
  "function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function decimals() view returns (uint8)",
  "error Error(string reason)",
]);

const payer: Address = "0x1111111111111111111111111111111111111111";
const payee: Address = "0x2222222222222222222222222222222222222222";
const otherCaller: Address = "0x3333333333333333333333333333333333333333";
const zeroBytes = `0x${"00".repeat(32)}` as Hex;
// Deliberately expired, zero value, and invalid signature. No signing is needed.
const args = [payer, payee, BigInt(0), BigInt(0), BigInt(0), zeroBytes, 27, zeroBytes, zeroBytes] as const;

type Outcome = { kind: "success"; data: Hex } | { kind: "error"; reason?: string; data?: Hex; message: string };

// Providers/viem may wrap revert data in data, originalError, or cause.
function findRevertData(value: unknown, seen = new Set<unknown>()): Hex | undefined {
  if (typeof value === "string" && /^0x08c379a0[0-9a-f]*$/i.test(value)) return value as Hex;
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of ["data", "cause", "error", "originalError", "result"]) {
    const data = findRevertData(record[key], seen);
    if (data) return data;
  }
}

async function main() {
  const networkName = process.argv[2];
  if ((networkName !== "testnet" && networkName !== "mainnet") || process.argv.length !== 3) {
    throw new Error("Usage: pnpm check:receive:testnet OR pnpm check:receive:mainnet");
  }
  const network = networks[networkName];
  const rpcUrl = process.env.ARC_RPC_URL || network.rpc;
  const url = new URL(rpcUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("ARC_RPC_URL must be an HTTP(S) URL.");
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }) });
  const chainId = await client.getChainId();
  if (chainId !== network.chainId) throw new Error(`Wrong network: expected chain ID ${network.chainId}, received ${chainId}.`);
  const block = await client.getBlock();
  const blockTag = `0x${block.number.toString(16)}` as Hex;

  console.log(`Network: Arc ${networkName} (chain ID ${chainId})`);
  console.log(`USDC: ${USDC}`);
  console.log(`Block: ${block.number} (${new Date(Number(block.timestamp) * 1000).toISOString()})`);
  console.log("Read-only eth_call probes. No transactions, private keys, or funds required.\n");

  // A system contract may have no bytecode, so eth_getCode is not a presence test.
  const decimals = await client.readContract({ address: USDC, abi, functionName: "decimals", blockNumber: block.number });
  console.log(`USDC decimals(): ${decimals}`);
  if (decimals !== 6) throw new Error("Unexpected decimals for Arc's documented USDC interface.");

  async function probe(label: string, data: Hex, caller: Address): Promise<Outcome> {
    try {
      const result = await client.request({
        method: "eth_call",
        params: [{ to: USDC, from: caller, data, gas: "0x7a120" }, blockTag],
      });
      console.log(`${label}: returned ${result} (success alone does not prove the function exists)`);
      return { kind: "success", data: result };
    } catch (error) {
      const data = findRevertData(error);
      let reason: string | undefined;
      if (data) {
        try {
          const decoded = decodeErrorResult({ abi, data });
          if (decoded.errorName === "Error") reason = decoded.args[0];
        } catch { /* Malformed or unfamiliar revert data is inconclusive. */ }
      }
      const message = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[RPC URL]") : "Unknown RPC error";
      console.log(`${label}: ${reason ?? message}`);
      if (data) console.log(`  Revert data: ${data}`);
      return { kind: "error", reason, data, message };
    }
  }

  const receiveData = encodeFunctionData({ abi, functionName: "receiveWithAuthorization", args });
  const transferData = encodeFunctionData({ abi, functionName: "transferWithAuthorization", args });
  const unknownData = `0xdeadbeef${receiveData.slice(10)}` as Hex;
  console.log(`\nRequired signature: receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)`);
  console.log(`Selector: ${receiveData.slice(0, 10)}\n`);

  const wrongPayee = await probe("receive / caller != payee", receiveData, otherCaller);
  const correctPayee = await probe("receive / caller == payee (expired)", receiveData, payee);
  await probe("transfer (expired; reference only)", transferData, otherCaller);
  const unknownWrong = await probe("unknown selector / caller != payee", unknownData, otherCaller);
  const unknownCorrect = await probe("unknown selector / caller == payee", unknownData, payee);

  const hasReason = (outcome: Outcome, reason: string) => outcome.kind === "error" && outcome.reason === reason;
  // Specific Circle checks, plus controls ruling out a generic fallback response.
  // https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP3009.sol
  const payeeReason = "FiatTokenV2: caller must be the payee";
  const expiryReason = "FiatTokenV2: authorization is expired";
  const confirmed = hasReason(wrongPayee, payeeReason)
    && hasReason(correctPayee, expiryReason)
    && !hasReason(unknownWrong, payeeReason)
    && !hasReason(unknownCorrect, expiryReason)
    // Transport errors in the controls cannot rule out fallback behavior.
    && (unknownWrong.kind === "success" || /revert/i.test(unknownWrong.message))
    && (unknownCorrect.kind === "success" || /revert/i.test(unknownCorrect.message));

  if (confirmed) {
    console.log("\nCONFIRMED: receiveWithAuthorization is recognized and enforces the payee and expiry checks at this block.");
    console.log("This checks function presence; a valid signed payment through your contract still needs an integration test.");
  } else {
    console.log("\nINCONCLUSIVE: the required function was not confirmed. This does NOT prove it is absent.");
    console.log("Compare the probe responses above; verify the deployed interface or try another RPC with ARC_RPC_URL.");
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[RPC URL]") : String(error);
  console.error(`\nCHECK FAILED: ${message}`);
  console.error("An RPC/configuration failure does NOT establish that receiveWithAuthorization is absent.");
  process.exitCode = 1;
});
