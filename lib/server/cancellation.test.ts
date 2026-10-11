import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeEventTopics, keccak256, toHex, type TransactionReceipt } from "viem";
import { prepaidAbi } from "../prepaid";
import { ARC_USDC } from "../db/authorization";
import { cancellationProof, confirmedCancellation, recentCancellationHash } from "./cancellation";

const key = { chainId: 5042002, prepaid: "0x1111111111111111111111111111111111111111", usdc: ARC_USDC,
  payer: "0x2222222222222222222222222222222222222222", scheduleId: keccak256(toHex("schedule")) } as const;
const hash = keccak256(toHex("cancel transaction")), blockHash = keccak256(toHex("block"));
function receipt(): TransactionReceipt {
  return { status: "success", transactionHash: hash, blockNumber: BigInt(123), blockHash,
    contractAddress: null, cumulativeGasUsed: BigInt(100000), effectiveGasPrice: BigInt(20000000000),
    from: key.payer, to: key.prepaid, gasUsed: BigInt(100000), logsBloom: "0x", transactionIndex: 0, type: "eip1559",
    logs: [{ address: key.prepaid, data: "0x", removed: false, transactionHash: hash, blockNumber: BigInt(123), blockHash,
      transactionIndex: 0, logIndex: 0, topics: encodeEventTopics({ abi: prepaidAbi, eventName: "ScheduleCancellation", args: { payer: key.payer, scheduleId: key.scheduleId } }) }],
  } as TransactionReceipt;
}
describe("cancellation chain evidence", () => {
  it("accepts only a successful event from the configured contract for this payer and schedule", () => {
    assert.deepEqual(cancellationProof(receipt(), key), { transactionHash: hash, blockNumber: "123", blockHash });
    assert.throws(() => cancellationProof({ ...receipt(), status: "reverted" }, key), /reverted/);
    assert.throws(() => cancellationProof({ ...receipt(), logs: [] }, key), /does not cancel/);
    const other = receipt(); other.logs[0].address = ARC_USDC;
    assert.throws(() => cancellationProof(other, key), /does not cancel/);
    assert.throws(() => cancellationProof(receipt(), { ...key, payer: key.prepaid }), /does not cancel/);
    assert.throws(() => cancellationProof(receipt(), { ...key, scheduleId: blockHash }), /does not cancel/);
    const removed = receipt(); removed.logs[0].removed = true;
    assert.throws(() => cancellationProof(removed, key), /does not cancel/);
  });
  it("checks the canonical block and permanent contract flag before producing database evidence", async () => {
    const fake = { getTransactionReceipt: async () => receipt(), getBlock: async () => ({ hash: blockHash }), readContract: async () => true };
    const client = fake as unknown as Parameters<typeof confirmedCancellation>[2];
    assert.equal((await confirmedCancellation(key, hash, client)).transactionHash, hash);
    await assert.rejects(confirmedCancellation(key, blockHash, client), /does not match/);
    fake.getBlock = async () => ({ hash });
    await assert.rejects(confirmedCancellation(key, hash, client), /not confirmed/);
    fake.getBlock = async () => ({ hash: blockHash }); fake.readContract = async () => false;
    await assert.rejects(confirmedCancellation(key, hash, client), /not confirmed/);
  });
  it("bounds recovery queries within Arc's log range limit and filters by contract, payer and ID", async () => {
    let requested: Record<string, unknown> = {};
    const client = { getBlockNumber: async () => BigInt(20000), getLogs: async (input: Record<string, unknown>) => { requested = input; return [{ removed: false, transactionHash: hash }]; } } as unknown as Parameters<typeof recentCancellationHash>[1];
    assert.equal(await recentCancellationHash(key, client), hash);
    assert.equal(requested.address, key.prepaid);
    assert.deepEqual(requested.args, { payer: key.payer, scheduleId: key.scheduleId });
    assert.equal(BigInt(requested.toBlock as bigint) - BigInt(requested.fromBlock as bigint), BigInt(9998));
  });
});
