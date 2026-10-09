import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, type Address } from "viem";

const USDC = "0x3600000000000000000000000000000000000000";
// Public Hardhat development key. Used only with the local test RPC, never Arc.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const script = fileURLToPath(new URL("../../../scripts/deploy-testnet.mts", import.meta.url));
const tsx = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));

async function fixture() {
  const connection = await network.create({ override: { chainId: 5042002 } });
  const client = await connection.viem.getPublicClient();
  const mock = await connection.viem.deployContract("MockUSDC");
  const code = await client.getCode({ address: mock.address });
  assert.ok(code);
  await connection.networkHelpers.setCode(USDC, code);
  const directory = await mkdtemp(join(tmpdir(), "prepaid-deployment-"));
  const methods: string[] = [];
  let responseMode = "normal";
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { id, method, params } = JSON.parse(body);
    methods.push(method);
    let result;
    let error;
    try {
      if (responseMode === "wrong-chain" && method === "eth_chainId") result = "0x13b2";
      else if (responseMode === "no-funds" && method === "eth_getBalance") result = "0x0";
      else result = await connection.provider.request({ method, params });
    } catch (cause) {
      error = { code: -32000, message: cause instanceof Error ? cause.message : "Local RPC error" };
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const rpcUrl = `http://127.0.0.1:${address.port}`;
  async function run(mode: "--check" | "--deploy", key = TEST_KEY) {
    const child = spawn(process.execPath, [tsx, script, mode], {
      cwd: directory,
      env: { ...process.env, ARC_TESTNET_PRIVATE_KEY: key, ARC_TESTNET_RPC_URL: rpcUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const status = await new Promise<number | null>((done, reject) => {
      child.on("error", reject);
      child.on("close", done);
    });
    assert.ok(!output.includes(TEST_KEY), "private keys must never appear in output");
    return { status, output };
  }
  async function close() {
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    await connection.close();
    // Only remove this test's freshly generated child of the system temp directory.
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("prepaid-deployment-"));
    await rm(directory, { recursive: true, force: true });
  }
  return { connection, client, directory, methods, run, close, setMode: (mode: string) => { responseMode = mode; } };
}

describe("Arc testnet deployment script (local EVM)", { concurrency: false }, () => {
  it("checks the real deployment bytecode without signing or sending a transaction", async () => {
    const f = await fixture();
    try {
      const result = await f.run("--check");
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /Preflight passed/);
      assert.ok(f.methods.includes("eth_estimateGas"));
      assert.ok(!f.methods.some((method) => method.startsWith("eth_send")));
      await assert.rejects(readFile(join(f.directory, "deployments/arc-testnet.json")), /ENOENT/);
    } finally { await f.close(); }
  });

  it("deploys only PrePaid, checks its owner/token, saves verification input, and prevents accidental redeployment", async () => {
    const f = await fixture();
    try {
      const result = await f.run("--deploy");
      assert.equal(result.status, 0, result.output);
      const record = JSON.parse(await readFile(join(f.directory, "deployments/arc-testnet.json"), "utf8"));
      assert.equal(record.status, "deployed");
      assert.equal(record.chainId, 5042002);
      assert.equal(record.usdc, USDC);
      const prepaid = await f.connection.viem.getContractAt("PrePaid", record.contractAddress as Address);
      assert.equal(getAddress(await prepaid.read.owner()), getAddress(record.deployer));
      assert.equal(getAddress(await prepaid.read.usdc()), getAddress(USDC));
      const input = JSON.parse(await readFile(join(f.directory, "deployments/arc-testnet-input.json"), "utf8"));
      assert.ok(Object.keys(input.sources).some((name) => name.endsWith("/PrePaid.sol")));
      assert.equal(input.settings.optimizer.runs, 200);
      assert.equal(input.settings.evmVersion, "cancun");
      const sends = f.methods.filter((method) => method === "eth_sendRawTransaction").length;
      assert.equal(sends, 1);
      const again = await f.run("--deploy");
      assert.equal(again.status, 1);
      assert.match(again.output, /already exists/);
      assert.equal(f.methods.filter((method) => method === "eth_sendRawTransaction").length, sends);
    } finally { await f.close(); }
  });

  for (const [mode, expected] of [["wrong-chain", /Wrong network/], ["no-funds", /cannot cover/]] as const) {
    it(`does not broadcast with ${mode}`, async () => {
      const f = await fixture();
      try {
        f.setMode(mode);
        const result = await f.run("--deploy");
        assert.equal(result.status, 1, result.output);
        assert.match(result.output, expected);
        assert.ok(!f.methods.some((method) => method.startsWith("eth_send")));
      } finally { await f.close(); }
    });
  }
});
