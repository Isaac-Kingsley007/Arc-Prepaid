import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import {
  encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseSignature,
  toHex, zeroAddress, zeroHash, type Address, type Hex, type TypedDataDomain,
} from "viem";

const { viem, networkHelpers } = await network.create();
const types = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" },
    { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
} as const;

async function deployFixture() {
  const [owner, payer, payee, relayer, other] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const usdc = await viem.deployContract("MockUSDC");
  const prepaid = await viem.deployContract("PrePaid", [usdc.address]);
  await usdc.write.mint([payer.account.address, 1_000_000_000n]);
  return { owner, payer, payee, relayer, other, usdc, prepaid, publicClient };
}
type Fixture = Awaited<ReturnType<typeof deployFixture>>;
type Payment = {
  payer: Address; scheduleId: Hex; payee: Address; amount: bigint; tip: bigint;
  validAfter: bigint; validBefore: bigint; salt: Hex; v: number; r: Hex; s: Hex;
};
const schedule = keccak256(toHex("schedule"));
let sequence = 0;

async function signedPayment(
  f: Fixture, overrides: Partial<Payment> = {}, signer = f.payer,
  target = f.prepaid.address,
  primaryType: "ReceiveWithAuthorization" | "TransferWithAuthorization" = "ReceiveWithAuthorization",
  domainOverrides: Partial<TypedDataDomain> = {},
) {
  const now = BigInt(await networkHelpers.time.latest());
  const payment: Payment = {
    payer: f.payer.account.address, scheduleId: schedule, payee: f.payee.account.address,
    amount: 100_000_000n, tip: 1_000_000n, validAfter: now + 100n, validBefore: now + 1_000n,
    salt: keccak256(toHex("occurrence-" + sequence++)), v: 27, r: zeroHash, s: zeroHash,
    ...overrides,
  };
  const nonce = await f.prepaid.read.getPaymentNonce([payment]);
  const signature = await signer.signTypedData({
    domain: { name: "USDC", version: "2", chainId: await f.publicClient.getChainId(), verifyingContract: f.usdc.address, ...domainOverrides },
    types: { ...types, TransferWithAuthorization: types.ReceiveWithAuthorization }, primaryType,
    message: { from: payment.payer, to: target, value: payment.amount + payment.tip,
      validAfter: payment.validAfter, validBefore: payment.validBefore, nonce },
  });
  const parsed = parseSignature(signature);
  return { ...payment, v: Number(parsed.v ?? BigInt(parsed.yParity!) + 27n), r: parsed.r, s: parsed.s };
}
async function activate(payment: Payment) {
  await networkHelpers.time.increaseTo(payment.validAfter + 1n);
}
async function execute(f: Fixture, payment: Payment) {
  return f.prepaid.write.executePayment([payment], { account: f.relayer.account });
}
async function executeBatch(f: Fixture, payments: Payment[], gas?: bigint) {
  const hash = await f.prepaid.write.executePayments([payments], { account: f.relayer.account, ...(gas ? { gas } : {}) });
  const receipt = await f.publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  return receipt;
}
async function assertUntouched(f: Fixture, payment: Payment) {
  assert.equal(await f.usdc.read.balanceOf([f.payer.account.address]), 1_000_000_000n);
  assert.equal(await f.usdc.read.balanceOf([f.payee.account.address]), 0n);
  assert.equal(await f.usdc.read.balanceOf([f.relayer.account.address]), 0n);
  assert.equal(await f.prepaid.read.accruedTips(), 0n);
  assert.equal(await f.usdc.read.authorizationState([payment.payer, await f.prepaid.read.getPaymentNonce([payment])]), false);
}

describe("PrePaid offchain authorizations", { concurrency: false }, () => {
  it("executes without registration, approval or deposit and splits the tip 70/30", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await assertUntouched(f, p);
    assert.equal(await f.usdc.read.allowance([p.payer, f.prepaid.address]), 0n);
    await activate(p);
    const receipt = await f.publicClient.waitForTransactionReceipt({ hash: await execute(f, p) });
    assert.equal(await f.usdc.read.balanceOf([p.payer]), 899_000_000n);
    assert.equal(await f.usdc.read.balanceOf([p.payee]), p.amount);
    assert.equal(await f.usdc.read.balanceOf([f.relayer.account.address]), 700_000n);
    assert.equal(await f.usdc.read.balanceOf([f.prepaid.address]), 300_000n);
    assert.equal(await f.prepaid.read.accruedTips(), 300_000n);
    const events = await f.publicClient.getContractEvents({
      address: f.prepaid.address, abi: f.prepaid.abi, eventName: "PaymentExecuted",
      fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].args.nonce, await f.prepaid.read.getPaymentNonce([p]));
    assert.equal(getAddress(events[0].args.executor!), getAddress(f.relayer.account.address));
    assert.equal(events[0].args.relayerTip, 700_000n);
    assert.equal(events[0].args.platformTip, 300_000n);
    await assert.rejects(execute(f, p), /authorization is used or canceled/);
  });

  it("matches independently ABI-encoded nonce commitments and ignores signature fields", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    const expected = keccak256(encodeAbiParameters([
      { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" },
      { type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" },
      { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" },
    ], [keccak256(toHex("PrePaidPayment(uint256 chainId,address prepaid,address usdc,address payer,bytes32 scheduleId,address payee,uint256 amount,uint256 tip,uint256 validAfter,uint256 validBefore,bytes32 salt)")),
      BigInt(await f.publicClient.getChainId()), f.prepaid.address, f.usdc.address,
      p.payer, p.scheduleId, p.payee, p.amount, p.tip, p.validAfter, p.validBefore, p.salt]));
    assert.equal(await f.prepaid.read.getPaymentNonce([p]), expected);
    assert.equal(await f.prepaid.read.getPaymentNonce([{ ...p, v: 0, r: zeroHash, s: zeroHash }]), expected);
    const second = await viem.deployContract("PrePaid", [f.usdc.address]);
    assert.notEqual(await second.read.getPaymentNonce([p]), expected);
  });

  it("rejects tampered routing, same-total tip changes, cancellation IDs, salts and windows", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await activate(p);
    const changes: Partial<Payment>[] = [
      { payee: f.other.account.address }, { amount: p.amount - 1n, tip: p.tip + 1n },
      { scheduleId: keccak256(toHex("another-schedule")) }, { salt: keccak256(toHex("another-salt")) },
      { validAfter: p.validAfter - 1n }, { validBefore: p.validBefore + 1n },
      { payer: f.other.account.address },
    ];
    for (const change of changes) await assert.rejects(execute(f, { ...p, ...change }), /Invalid signature/);
    await assertUntouched(f, p);
    await execute(f, p);
  });

  it("rejects signatures for another caller destination, signer, message type or token domain", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const payments = [
      await signedPayment(f, {}, f.payer, f.other.account.address),
      await signedPayment(f, {}, f.other),
      await signedPayment(f, {}, f.payer, f.prepaid.address, "TransferWithAuthorization"),
      await signedPayment(f, {}, f.payer, f.prepaid.address, "ReceiveWithAuthorization", { chainId: 5042 }),
      await signedPayment(f, {}, f.payer, f.prepaid.address, "ReceiveWithAuthorization", { verifyingContract: f.other.account.address }),
    ];
    await activate(payments[0]);
    for (const p of payments) await assert.rejects(execute(f, p), /Invalid signature/);
    await assertUntouched(f, payments[0]);
  });

  it("enforces exclusive EIP-3009 window boundaries", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    const simulate = () => f.publicClient.simulateContract({
      address: f.prepaid.address, abi: f.prepaid.abi, functionName: "executePayment",
      args: [p], account: f.relayer.account,
    });
    await assert.rejects(simulate(), /PaymentOutsideWindow/);
    await networkHelpers.time.increaseTo(p.validAfter);
    await assert.rejects(simulate(), /PaymentOutsideWindow/);
    await activate(p);
    await simulate();
    await networkHelpers.time.increaseTo(p.validBefore);
    await assert.rejects(simulate(), /PaymentOutsideWindow/);
    await assertUntouched(f, p);
  });

  it("rejects invalid payer, schedule, payee, amount and windows", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await activate(p);
    const invalid: Partial<Payment>[] = [
      { payer: zeroAddress }, { scheduleId: zeroHash }, { payee: zeroAddress },
      { payee: f.prepaid.address }, { payee: f.usdc.address }, { amount: 0n },
      { validBefore: p.validAfter }, { validBefore: p.validAfter - 1n },
    ];
    for (const change of invalid) await assert.rejects(execute(f, { ...p, ...change }), /InvalidPayment/);
    await assertUntouched(f, p);
  });

  it("cancels before first execution and cannot bypass cancellation by rewriting scheduleId", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    const p2 = await signedPayment(f, { validAfter: p.validAfter, validBefore: p.validBefore });
    await f.prepaid.write.cancelSchedule([schedule], { account: f.payer.account });
    await activate(p);
    for (const payment of [p, p2]) await assert.rejects(execute(f, payment), /ScheduleCancelled/);
    await assert.rejects(execute(f, { ...p, scheduleId: keccak256(toHex("bypass")) }), /Invalid signature/);
    await assertUntouched(f, p);
    await assert.rejects(f.prepaid.write.cancelSchedule([schedule], { account: f.payer.account }), /ScheduleAlreadyCancelled/);
    await assert.rejects(f.prepaid.write.cancelSchedule([zeroHash], { account: f.payer.account }), /InvalidScheduleId/);
  });

  it("scopes cancellations to the caller, preserves past payments and other schedules", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    const remaining = await signedPayment(f, { validAfter: p.validAfter, validBefore: p.validBefore });
    const other = await signedPayment(f, { scheduleId: keccak256(toHex("other")) });
    await f.prepaid.write.cancelSchedule([schedule], { account: f.other.account });
    assert.equal(await f.prepaid.read.cancelledSchedules([p.payer, schedule]), false);
    await activate(p);
    await execute(f, p);
    await f.prepaid.write.cancelSchedule([schedule], { account: f.payer.account });
    await assert.rejects(execute(f, remaining), /ScheduleCancelled/);
    await execute(f, other);
    assert.equal(await f.usdc.read.balanceOf([p.payee]), p.amount + other.amount);
    assert.equal(await f.prepaid.read.accruedTips(), 600_000n);
  });

  it("uses fresh salts for distinct occurrences and USDC for replay/revocation", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    const p2 = await signedPayment(f, { validAfter: p.validAfter, validBefore: p.validBefore });
    assert.notEqual(await f.prepaid.read.getPaymentNonce([p]), await f.prepaid.read.getPaymentNonce([p2]));
    await activate(p);
    await execute(f, p);
    await execute(f, p2);
    await assert.rejects(execute(f, p), /authorization is used or canceled/);
    const revoked = await signedPayment(f, { validAfter: p.validAfter, validBefore: p.validBefore });
    await f.usdc.write.cancelAuthorization([await f.prepaid.read.getPaymentNonce([revoked])], { account: f.payer.account });
    await assert.rejects(execute(f, revoked), /authorization is used or canceled/);
    assert.equal(await f.usdc.read.balanceOf([p.payee]), p.amount + p2.amount);
  });

  for (const blockedRecipient of ["payee", "relayer"] as const) {
    it("rolls back receipt, nonce and both tips when " + blockedRecipient + " is blocklisted, then retries", async () => {
      const f = await networkHelpers.loadFixture(deployFixture);
      const p = await signedPayment(f);
      await activate(p);
      await f.usdc.write.setBlocked([f[blockedRecipient].account.address, true]);
      await assert.rejects(execute(f, p), /USDC blocklisted/);
      await assertUntouched(f, p);
      await f.usdc.write.setBlocked([f[blockedRecipient].account.address, false]);
      await execute(f, p);
      assert.equal(await f.prepaid.read.accruedTips(), 300_000n);
    });
  }

  it("rolls back on ERC20 false returns and silent receive successes", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await activate(p);
    await f.usdc.write.setFailTransfers([true]);
    await assert.rejects(execute(f, p), /SafeERC20FailedOperation/);
    await assertUntouched(f, p);
    await f.usdc.write.setFailTransfers([false]);
    await f.usdc.write.mint([f.prepaid.address, 500_000_000n]);
    await f.usdc.write.setNoReceive([true]);
    await assert.rejects(execute(f, p), /UnexpectedUSDCBalance/);
    await assertUntouched(f, p);
    assert.equal(await f.usdc.read.balanceOf([f.prepaid.address]), 500_000_000n);
  });

  it("isolates failed, cancelled, pending, expired and duplicate batch entries", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const good = await signedPayment(f);
    const blocked = await signedPayment(f, { payee: f.other.account.address });
    const cancelled = await signedPayment(f, { scheduleId: keccak256(toHex("cancelled")) });
    const pending = await signedPayment(f, { validAfter: good.validAfter + 500n });
    const expired = await signedPayment(f, { validAfter: 0n, validBefore: good.validAfter });
    await f.prepaid.write.cancelSchedule([cancelled.scheduleId], { account: f.payer.account });
    await f.usdc.write.setBlocked([f.other.account.address, true]);
    await activate(good);
    const payments = [blocked, cancelled, pending, expired, good, good];
    const simulation = await f.publicClient.simulateContract({
      address: f.prepaid.address, abi: f.prepaid.abi, functionName: "executePayments",
      args: [payments], account: f.relayer.account, gas: 3_000_000n,
    });
    assert.equal(simulation.result, 1n);
    const receipt = await executeBatch(f, payments);
    const failures = await f.publicClient.getContractEvents({
      address: f.prepaid.address, abi: f.prepaid.abi, eventName: "PaymentFailed",
      fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
    });
    assert.deepEqual(failures.map((event) => event.args.index), [0n, 1n, 2n, 3n, 5n]);
    assert.equal(await f.usdc.read.authorizationState([blocked.payer, await f.prepaid.read.getPaymentNonce([blocked])]), false);
    assert.equal(await f.usdc.read.balanceOf([good.payee]), good.amount);
    assert.equal(await f.usdc.read.balanceOf([f.relayer.account.address]), 700_000n);
    assert.equal(await f.prepaid.read.accruedTips(), 300_000n);
  });

  it("rejects empty/oversized batches, direct worker calls and insufficient outer gas", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await activate(p);
    await assert.rejects(f.prepaid.write.executePayments([[]]), /InvalidBatchSize/);
    await assert.rejects(f.prepaid.write.executePayments([Array(51).fill(p)]), /InvalidBatchSize/);
    await assert.rejects(f.prepaid.write.executePaymentFromBatch([p, f.other.account.address]), /OnlySelf/);
    await assert.rejects(executeBatch(f, [p], 150_000n), /InsufficientBatchGas/);
    await assertUntouched(f, p);
  });

  it("executes 50 payments with normal gas estimation and credits the actual batch caller", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const payments: Payment[] = [];
    const now = BigInt(await networkHelpers.time.latest());
    for (let i = 0; i < 50; i++) payments.push(await signedPayment(f, {
      amount: 1_000_000n, tip: 10_000n, validAfter: now + 100n, validBefore: now + 1_000n,
    }));
    await activate(payments[0]);
    await executeBatch(f, payments);
    assert.equal(await f.usdc.read.balanceOf([f.payee.account.address]), 50_000_000n);
    assert.equal(await f.usdc.read.balanceOf([f.relayer.account.address]), 350_000n);
    assert.equal(await f.prepaid.read.accruedTips(), 150_000n);
    for (const p of payments) assert.equal(await f.usdc.read.authorizationState([p.payer, await f.prepaid.read.getPaymentNonce([p])]), true);
  });

  it("keeps underfunded or paused payments retryable within their windows", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f, { amount: 2_000_000_000n });
    await activate(p);
    await executeBatch(f, [p]);
    await assertUntouched(f, p);
    await f.usdc.write.mint([p.payer, 2_000_000_000n]);
    await f.usdc.write.setPaused([true]);
    await executeBatch(f, [p]);
    assert.equal(await f.usdc.read.authorizationState([p.payer, await f.prepaid.read.getPaymentNonce([p])]), false);
    await f.usdc.write.setPaused([false]);
    await executeBatch(f, [p]);
    assert.equal(await f.prepaid.read.accruedTips(), 300_000n);
  });

  it("handles zero tips and rounds fractional relayer units down to the platform", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const first = await signedPayment(f, { tip: 0n });
    const second = await signedPayment(f, { tip: 1n });
    const third = await signedPayment(f, { tip: 11n });
    await activate(first);
    await executeBatch(f, [first, second, third]);
    assert.equal(await f.usdc.read.balanceOf([f.relayer.account.address]), 7n);
    assert.equal(await f.prepaid.read.accruedTips(), 5n);
    assert.equal(await f.usdc.read.balanceOf([f.prepaid.address]), 5n);
  });

  it("withdraws only the platform share, protects donations and supports two-step ownership", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await activate(p);
    await execute(f, p);
    await f.usdc.write.mint([f.prepaid.address, 5_000_000n]);
    await assert.rejects(f.prepaid.write.withdrawTips([f.other.account.address], { account: f.other.account }), /OwnableUnauthorizedAccount/);
    for (const recipient of [zeroAddress, f.prepaid.address, f.usdc.address]) await assert.rejects(f.prepaid.write.withdrawTips([recipient]), /InvalidRecipient/);
    await f.prepaid.write.transferOwnership([f.other.account.address]);
    assert.equal(getAddress(await f.prepaid.read.owner()), getAddress(f.owner.account.address));
    await f.prepaid.write.acceptOwnership({ account: f.other.account });
    await assert.rejects(f.prepaid.write.withdrawTips([f.owner.account.address]), /OwnableUnauthorizedAccount/);
    await f.prepaid.write.withdrawTips([f.other.account.address], { account: f.other.account });
    assert.equal(await f.usdc.read.balanceOf([f.other.account.address]), 300_000n);
    assert.equal(await f.usdc.read.balanceOf([f.relayer.account.address]), 700_000n);
    assert.equal(await f.usdc.read.balanceOf([f.prepaid.address]), 5_000_000n);
    assert.equal(await f.prepaid.read.accruedTips(), 0n);
    await assert.rejects(f.prepaid.write.withdrawTips([f.other.account.address], { account: f.other.account }), /NoTips/);
  });

  it("restores platform tip accounting when a withdrawal transfer fails", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await activate(p);
    await execute(f, p);
    await f.usdc.write.setBlocked([f.owner.account.address, true]);
    await assert.rejects(f.prepaid.write.withdrawTips([f.owner.account.address]), /USDC blocklisted/);
    assert.equal(await f.prepaid.read.accruedTips(), 300_000n);
    assert.equal(await f.usdc.read.balanceOf([f.prepaid.address]), 300_000n);
  });

  it("blocks reentry into single execution, batch execution, cancellation, withdrawal and the batch worker", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await activate(p);
    const attempts = [
      encodeFunctionData({ abi: f.prepaid.abi, functionName: "executePayment", args: [p] }),
      encodeFunctionData({ abi: f.prepaid.abi, functionName: "executePayments", args: [[p]] }),
      encodeFunctionData({ abi: f.prepaid.abi, functionName: "cancelSchedule", args: [schedule] }),
      encodeFunctionData({ abi: f.prepaid.abi, functionName: "withdrawTips", args: [f.other.account.address] }),
      encodeFunctionData({ abi: f.prepaid.abi, functionName: "executePaymentFromBatch", args: [p, f.other.account.address] }),
    ];
    for (const data of attempts) {
      const next = await signedPayment(f, { validAfter: p.validAfter, validBefore: p.validBefore });
      await f.usdc.write.setCallback([f.prepaid.address, data]);
      await executeBatch(f, [next]);
      assert.equal(await f.usdc.read.callbackSucceeded(), false);
    }
    assert.equal(await f.usdc.read.balanceOf([f.payee.account.address]), 5n * p.amount);
    assert.equal(await f.prepaid.read.accruedTips(), 1_500_000n);
  });
});
