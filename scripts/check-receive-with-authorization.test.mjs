import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { encodeErrorResult, encodeFunctionData, parseAbi } from "viem";

const abi = parseAbi([
  "error Error(string reason)",
  "function receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
]);
const zero = `0x${"00".repeat(32)}`;
const receiveSelector = encodeFunctionData({
  abi,
  functionName: "receiveWithAuthorization",
  args: ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222", 0n, 0n, 0n, zero, 27, zero, zero],
}).slice(0, 10);

async function runProbe(mode) {
  const methods = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { id, method, params } = JSON.parse(body);
    methods.push(method);
    let result;
    let error;
    if (method === "eth_chainId") result = mode === "wrong-chain" ? "0x1" : "0x4cef52";
    else if (method === "eth_getBlockByNumber") result = {
      number: "0x1", timestamp: "0x1", hash: zero, parentHash: zero,
      transactions: [], gasLimit: "0x1", gasUsed: "0x0", size: "0x1",
      difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x",
    };
    else if (method === "eth_call" && params[0].data === "0x313ce567") result = `0x${"0".repeat(63)}6`;
    else if (method === "eth_call") {
      const call = params[0];
      const recognized = call.data.startsWith(receiveSelector) || mode === "generic-fallback";
      const reason = recognized
        ? call.from === "0x3333333333333333333333333333333333333333"
          ? "FiatTokenV2: caller must be the payee"
          : "FiatTokenV2: authorization is expired"
        : undefined;
      if (mode === "empty-success") result = "0x";
      else error = { code: 3, message: "execution reverted", data: reason ? encodeErrorResult({ abi, errorName: "Error", args: [reason] }) : "0x" };
    } else error = { code: -32601, message: "Unexpected method" };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/check-receive-with-authorization.ts", "testnet"], {
      env: { ...process.env, ARC_RPC_URL: `http://127.0.0.1:${server.address().port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.ok(methods.every((method) => ["eth_chainId", "eth_getBlockByNumber", "eth_call"].includes(method)), "probe must use only read-only RPCs");
    return { code, output };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

for (const [mode, code, marker] of [
  ["recognized", 0, "CONFIRMED:"],
  ["generic-fallback", 2, "INCONCLUSIVE:"],
  ["empty-success", 2, "INCONCLUSIVE:"],
  ["wrong-chain", 1, "Wrong network:"],
]) {
  test(mode, async () => {
    const result = await runProbe(mode);
    assert.equal(result.code, code, result.output);
    assert.ok(result.output.includes(marker), result.output);
  });
}
