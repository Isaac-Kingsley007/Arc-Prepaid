import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, getAddress, keccak256, parseSignature, toHex, zeroAddress, type Address, type Hex, type TypedDataDomain } from "viem";

const { viem, networkHelpers } = await network.create();
const types = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
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
type Fields = { payee: Address; amount: bigint; tip: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex };

async function signedPayment(f: Fixture, overrides: Partial<Fields> = {}, signer = f.payer, target = f.prepaid.address, primaryType: "ReceiveWithAuthorization" | "TransferWithAuthorization" = "ReceiveWithAuthorization", domainOverrides: Partial<TypedDataDomain> = {}) {
  const now = BigInt(await networkHelpers.time.latest());
  const fields: Fields = {
    payee: f.payee.account.address,
    amount: 100_000_000n,
    tip: 1_000_000n,
    validAfter: now + 100n,
    validBefore: now + 1_000n,
    nonce: keccak256(toHex(`payment-${now}-${await f.prepaid.read.nextPaymentId()}`)),
    ...overrides,
  };
  const message = {
    from: signer.account.address,
    to: target,
    value: fields.amount + fields.tip,
    validAfter: fields.validAfter,
    validBefore: fields.validBefore,
    nonce: fields.nonce,
  };
  const signature = await signer.signTypedData({
    domain: { name: "USDC", version: "2", chainId: await f.publicClient.getChainId(), verifyingContract: f.usdc.address, ...domainOverrides },
    types: { ...types, TransferWithAuthorization: types.ReceiveWithAuthorization },
    primaryType,
    message,
  });
  const parsed = parseSignature(signature);
  return { ...fields, v: Number(parsed.v ?? BigInt(parsed.yParity!) + 27n), r: parsed.r, s: parsed.s };
}

async function register(f: Fixture, payments: Awaited<ReturnType<typeof signedPayment>>[]) {
  return f.prepaid.write.createSchedule([payments], { account: f.payer.account });
}
async function executeBatch(f: Fixture, ids: bigint[]) {
  const hash = await f.prepaid.write.executePayments([ids], { account: f.relayer.account, gas: 2_000_000n });
  const receipt = await f.publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  return receipt;
}

describe("PrePaid", { concurrency: false }, () => {
  it("stores signatures and forwarding instructions without taking funds or approvals", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await register(f, [p]);
    const payment = await f.prepaid.read.getPayment([1n]);
    assert.equal(payment.scheduleId, 1n);
    assert.equal(getAddress(payment.payee), getAddress(p.payee));
    for (const key of ["amount", "tip", "validAfter", "validBefore", "nonce", "v", "r", "s"] as const) assert.equal(payment[key], p[key]);
    assert.equal(payment.executed, false);
    const schedule = await f.prepaid.read.schedules([1n]);
    assert.equal(getAddress(schedule[0]), getAddress(f.payer.account.address));
    assert.deepEqual(schedule.slice(1), [1n, 1n, false]);
    assert.equal(await f.usdc.read.balanceOf([f.payer.account.address]), 1_000_000_000n);
    assert.equal(await f.usdc.read.balanceOf([f.prepaid.address]), 0n);
    assert.equal(await f.usdc.read.allowance([f.payer.account.address, f.prepaid.address]), 0n);
    assert.equal(await f.usdc.read.authorizationState([f.payer.account.address, p.nonce]), false);
  });

  it("receives the total, pays the intended payee, retains only the tip and cannot execute twice", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await register(f, [p]);
    await networkHelpers.time.increaseTo(p.validAfter + 1n);
    const hash = await f.prepaid.write.executePayment([1n], { account: f.relayer.account });
    const receipt = await f.publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    assert.equal(await f.usdc.read.balanceOf([f.payer.account.address]), 899_000_000n);
    assert.equal(await f.usdc.read.balanceOf([f.payee.account.address]), p.amount);
    assert.equal(await f.usdc.read.balanceOf([f.prepaid.address]), p.tip);
    assert.equal(await f.prepaid.read.accruedTips(), p.tip);
    assert.equal(await f.usdc.read.authorizationState([f.payer.account.address, p.nonce]), true);
    assert.equal(await f.prepaid.read.getPaymentState([1n]), 3);
    await assert.rejects(f.prepaid.write.executePayment([1n]), /PaymentNotExecutable/);
  });

  it("uses exclusive EIP-3009 boundaries and never executes too early or after expiry", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await register(f, [p]);
    assert.equal(await f.prepaid.read.getPaymentState([1n]), 1);
    await assert.rejects(f.prepaid.write.executePayment([1n]), /PaymentNotExecutable/);
    await networkHelpers.time.increaseTo(p.validAfter);
    assert.equal(await f.prepaid.read.getPaymentState([1n]), 1);
    await assert.rejects(f.publicClient.simulateContract({ address: f.prepaid.address, abi: f.prepaid.abi, functionName: "executePayment", args: [1n], account: f.relayer.account }), /PaymentNotExecutable/);
    await networkHelpers.time.increaseTo(p.validAfter + 1n);
    assert.equal(await f.prepaid.read.getPaymentState([1n]), 2);
    await networkHelpers.time.increaseTo(p.validBefore);
    assert.equal(await f.prepaid.read.getPaymentState([1n]), 5);
    await assert.rejects(f.prepaid.write.executePayment([1n]), /PaymentNotExecutable/);
    assert.equal(await f.usdc.read.balanceOf([f.prepaid.address]), 0n);
  });

  it("prevents another user registering a stolen authorization with a different payee or tip", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await assert.rejects(f.prepaid.write.createSchedule([[{ ...p, payee: f.other.account.address }]], { account: f.other.account }), /InvalidSignature/);
    await assert.rejects(register(f, [{ ...p, amount: p.amount - 1n }]), /InvalidSignature/);
    assert.equal(await f.prepaid.read.nextPaymentId(), 1n);
  });

  it("rejects signatures for another destination, another signer, or TransferWithAuthorization", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    await assert.rejects(register(f, [await signedPayment(f, {}, f.payer, f.other.account.address)]), /InvalidSignature/);
    await assert.rejects(register(f, [await signedPayment(f, {}, f.other)]), /InvalidSignature/);
    await assert.rejects(register(f, [await signedPayment(f, {}, f.payer, f.prepaid.address, "TransferWithAuthorization")]), /InvalidSignature/);
  });

  it("rejects signatures from another chain or another token's EIP-712 domain", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    for (const domain of [{ chainId: 5042 }, { verifyingContract: f.other.account.address }]) {
      const p = await signedPayment(f, {}, f.payer, f.prepaid.address, "ReceiveWithAuthorization", domain);
      await assert.rejects(register(f, [p]), /InvalidSignature/);
    }
  });

  it("rejects empty/oversized schedules, invalid payees, amounts and windows", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    await assert.rejects(register(f, []), /InvalidBatchSize/);
    const p = await signedPayment(f);
    await assert.rejects(register(f, Array(51).fill(p)), /InvalidBatchSize/);
    for (const payee of [zeroAddress, f.prepaid.address, f.usdc.address]) await assert.rejects(register(f, [{ ...p, payee }]), /InvalidPayment/);
    await assert.rejects(register(f, [{ ...p, amount: 0n }]), /InvalidPayment/);
    await assert.rejects(register(f, [{ ...p, validBefore: p.validAfter }]), /InvalidPayment/);
    await assert.rejects(register(f, [{ ...p, validBefore: 1n, validAfter: 0n }]), /InvalidPayment/);
  });

  it("rejects duplicate nonces within/across schedules and authorizations already revoked at USDC", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await assert.rejects(register(f, [p, p]), /NonceUnavailable/);
    assert.equal(await f.prepaid.read.nextScheduleId(), 1n);
    await register(f, [p]);
    await assert.rejects(register(f, [p]), /NonceUnavailable/);
    const revoked = await signedPayment(f);
    await f.usdc.write.cancelAuthorization([revoked.nonce], { account: f.payer.account });
    await assert.rejects(register(f, [revoked]), /NonceUnavailable/);
  });

  it("cancels all remaining schedule payments while preserving executed payments and other schedules", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    const p2 = await signedPayment(f, { nonce: keccak256(toHex("second")) });
    await register(f, [p, p2]);
    const p3 = await signedPayment(f);
    await register(f, [p3]);
    await networkHelpers.time.increaseTo(p.validAfter + 1n);
    await f.prepaid.write.executePayment([1n]);
    await f.prepaid.write.cancelSchedule([1n], { account: f.payer.account });
    assert.equal(await f.prepaid.read.getPaymentState([1n]), 3);
    assert.equal(await f.prepaid.read.getPaymentState([2n]), 4);
    await assert.rejects(f.prepaid.write.executePayment([2n]), /PaymentNotExecutable/);
    assert.equal(await f.usdc.read.authorizationState([f.payer.account.address, p2.nonce]), false);
    await assert.rejects(register(f, [p2]), /NonceUnavailable/);
    await f.prepaid.write.executePayment([3n]);
    assert.equal(await f.prepaid.read.accruedTips(), p.tip + p3.tip);
  });

  it("only the corresponding payer may cancel; repeated and unknown cancellations are rejected", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    await register(f, [await signedPayment(f)]);
    for (const account of [f.owner.account, f.relayer.account, f.other.account]) await assert.rejects(f.prepaid.write.cancelSchedule([1n], { account }), /NotSchedulePayer/);
    await assert.rejects(f.prepaid.write.cancelSchedule([99n], { account: f.payer.account }), /UnknownSchedule/);
    await f.prepaid.write.cancelSchedule([1n], { account: f.payer.account });
    await assert.rejects(f.prepaid.write.cancelSchedule([1n], { account: f.payer.account }), /ScheduleAlreadyCancelled/);
  });

  it("rolls back the payer debit, nonce, execution and tip if forwarding is rejected, then retries", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await register(f, [p]);
    await networkHelpers.time.increaseTo(p.validAfter + 1n);
    await f.usdc.write.setBlocked([f.payee.account.address, true]);
    await assert.rejects(f.prepaid.write.executePayment([1n]), /USDC blocklisted/);
    assert.equal(await f.usdc.read.balanceOf([f.payer.account.address]), 1_000_000_000n);
    assert.equal(await f.usdc.read.authorizationState([f.payer.account.address, p.nonce]), false);
    assert.equal((await f.prepaid.read.getPayment([1n])).executed, false);
    assert.equal(await f.prepaid.read.accruedTips(), 0n);
    await f.usdc.write.setBlocked([f.payee.account.address, false]);
    await f.prepaid.write.executePayment([1n]);
    assert.equal(await f.usdc.read.balanceOf([f.payee.account.address]), p.amount);
  });

  it("treats an ERC-20 false return as failure and leaves the authorization available", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await register(f, [p]);
    await networkHelpers.time.increaseTo(p.validAfter + 1n);
    await f.usdc.write.setFailTransfers([true]);
    await assert.rejects(f.prepaid.write.executePayment([1n]), /SafeERC20FailedOperation/);
    assert.equal(await f.usdc.read.authorizationState([f.payer.account.address, p.nonce]), false);
    assert.equal(await f.usdc.read.balanceOf([f.payer.account.address]), 1_000_000_000n);
    assert.equal(await f.prepaid.read.accruedTips(), 0n);
  });

  it("never spends existing contract funds if receiving silently returns without transferring", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await register(f, [p]);
    await f.usdc.write.mint([f.prepaid.address, 500_000_000n]);
    await f.usdc.write.setNoReceive([true]);
    await networkHelpers.time.increaseTo(p.validAfter + 1n);
    await assert.rejects(f.prepaid.write.executePayment([1n]), /UnexpectedUSDCBalance/);
    assert.equal(await f.usdc.read.balanceOf([f.prepaid.address]), 500_000_000n);
    assert.equal(await f.usdc.read.balanceOf([f.payee.account.address]), 0n);
    assert.equal(await f.prepaid.read.accruedTips(), 0n);
  });

  it("isolates a failed payment in a batch, executes a healthy one, and skips unknown or duplicate IDs", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p1 = await signedPayment(f, { payee: f.other.account.address });
    const p2 = await signedPayment(f, { nonce: keccak256(toHex("healthy")) });
    await register(f, [p1, p2]);
    await networkHelpers.time.increaseTo(p2.validAfter + 1n);
    await f.usdc.write.setBlocked([f.other.account.address, true]);
    const receipt = await executeBatch(f, [1n, 2n, 2n, 999n]);
    const failures = await f.publicClient.getContractEvents({ address: f.prepaid.address, abi: f.prepaid.abi, eventName: "PaymentFailed", fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].args.paymentId, 1n);
    assert.equal(await f.prepaid.read.getPaymentState([1n]), 2);
    assert.equal(await f.prepaid.read.getPaymentState([2n]), 3);
    assert.equal(await f.usdc.read.authorizationState([f.payer.account.address, p1.nonce]), false);
    assert.equal(await f.usdc.read.balanceOf([f.payee.account.address]), p2.amount);
    assert.equal(await f.prepaid.read.accruedTips(), p2.tip);
  });

  it("skips non-ready batches and rejects empty/oversized batches and direct worker calls", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await register(f, [p]);
    await executeBatch(f, [1n, 0n]);
    assert.equal(await f.prepaid.read.accruedTips(), 0n);
    await assert.rejects(f.prepaid.write.executePayments([[]]), /InvalidBatchSize/);
    await assert.rejects(f.prepaid.write.executePayments([Array(51).fill(1n)]), /InvalidBatchSize/);
    await assert.rejects(f.prepaid.write.executePaymentFromBatch([1n, f.relayer.account.address]), /OnlySelf/);
  });

  it("rejects a low-gas batch without consuming the authorization", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await register(f, [p]);
    await networkHelpers.time.increaseTo(p.validAfter + 1n);
    await assert.rejects(f.prepaid.write.executePayments([[1n]], { account: f.relayer.account, gas: 150_000n }), /InsufficientBatchGas/);
    assert.equal(await f.prepaid.read.getPaymentState([1n]), 2);
    assert.equal(await f.usdc.read.authorizationState([f.payer.account.address, p.nonce]), false);
  });

  it("normal gas estimation attempts all ready payments rather than silently doing no work", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    const p2 = await signedPayment(f, { nonce: keccak256(toHex("estimated-batch")) });
    await register(f, [p, p2]);
    await networkHelpers.time.increaseTo(p.validAfter + 1n);
    const hash = await f.prepaid.write.executePayments([[1n, 2n]], { account: f.relayer.account });
    const receipt = await f.publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    assert.equal(await f.prepaid.read.getPaymentState([1n]), 3);
    assert.equal(await f.prepaid.read.getPaymentState([2n]), 3);
    assert.equal(await f.prepaid.read.accruedTips(), p.tip + p2.tip);
  });

  it("registers and executes the maximum 50-payment schedule with normal gas estimation", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const payments = [];
    for (let i = 0; i < 50; i++) payments.push(await signedPayment(f, {
      amount: 1_000_000n, tip: 10_000n, nonce: keccak256(toHex(`max-schedule-${i}`)),
    }));
    await register(f, payments);
    await networkHelpers.time.increaseTo(payments[0].validAfter + 1n);
    const ids = Array.from({ length: 50 }, (_, index) => BigInt(index + 1));
    const hash = await f.prepaid.write.executePayments([ids], { account: f.relayer.account });
    const receipt = await f.publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    assert.equal(await f.usdc.read.balanceOf([f.payee.account.address]), 50_000_000n);
    assert.equal(await f.prepaid.read.accruedTips(), 500_000n);
    for (const id of ids) assert.equal(await f.prepaid.read.getPaymentState([id]), 3);
  });

  it("handles insufficient payer funds, revoked authorization, and paused USDC without losing a payment", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f, { amount: 2_000_000_000n });
    await register(f, [p]);
    await networkHelpers.time.increaseTo(p.validAfter + 1n);
    await executeBatch(f, [1n]);
    assert.equal(await f.usdc.read.authorizationState([f.payer.account.address, p.nonce]), false);
    await f.usdc.write.mint([f.payer.account.address, 2_000_000_000n]);
    await f.usdc.write.setPaused([true]);
    await executeBatch(f, [1n]);
    assert.equal((await f.prepaid.read.getPayment([1n])).executed, false);
    await f.usdc.write.setPaused([false]);
    await f.usdc.write.cancelAuthorization([p.nonce], { account: f.payer.account });
    await executeBatch(f, [1n]);
    assert.equal((await f.prepaid.read.getPayment([1n])).executed, false);
    assert.equal(await f.prepaid.read.accruedTips(), 0n);
  });

  it("withdraws only accrued tips as owner, protects donations, and supports two-step ownership", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await register(f, [p]);
    await networkHelpers.time.increaseTo(p.validAfter + 1n);
    await f.prepaid.write.executePayment([1n]);
    await f.usdc.write.mint([f.prepaid.address, 5_000_000n]);
    await assert.rejects(f.prepaid.write.withdrawTips([f.other.account.address], { account: f.other.account }), /OwnableUnauthorizedAccount/);
    for (const recipient of [zeroAddress, f.prepaid.address, f.usdc.address]) await assert.rejects(f.prepaid.write.withdrawTips([recipient]), /InvalidRecipient/);
    await f.prepaid.write.transferOwnership([f.other.account.address]);
    assert.equal(getAddress(await f.prepaid.read.owner()), getAddress(f.owner.account.address));
    await f.prepaid.write.acceptOwnership({ account: f.other.account });
    await assert.rejects(f.prepaid.write.withdrawTips([f.owner.account.address]), /OwnableUnauthorizedAccount/);
    await f.prepaid.write.withdrawTips([f.relayer.account.address], { account: f.other.account });
    assert.equal(await f.usdc.read.balanceOf([f.relayer.account.address]), p.tip);
    assert.equal(await f.usdc.read.balanceOf([f.prepaid.address]), 5_000_000n);
    assert.equal(await f.prepaid.read.accruedTips(), 0n);
    await assert.rejects(f.prepaid.write.withdrawTips([f.relayer.account.address], { account: f.other.account }), /NoTips/);
  });

  it("restores the accrued tip ledger when withdrawal fails", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await register(f, [p]);
    await networkHelpers.time.increaseTo(p.validAfter + 1n);
    await f.prepaid.write.executePayment([1n]);
    await f.usdc.write.setBlocked([f.owner.account.address, true]);
    await assert.rejects(f.prepaid.write.withdrawTips([f.owner.account.address]), /USDC blocklisted/);
    assert.equal(await f.prepaid.read.accruedTips(), p.tip);
    assert.equal(await f.usdc.read.balanceOf([f.prepaid.address]), p.tip);
  });

  it("blocks reentrancy into execution during forwarding", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f);
    await register(f, [p]);
    await networkHelpers.time.increaseTo(p.validAfter + 1n);
    await f.usdc.write.setCallback([f.prepaid.address, encodeFunctionData({ abi: f.prepaid.abi, functionName: "executePayment", args: [1n] })]);
    await executeBatch(f, [1n]);
    assert.equal(await f.usdc.read.callbackSucceeded(), false);
    assert.equal(await f.usdc.read.balanceOf([f.payee.account.address]), p.amount);
    assert.equal(await f.prepaid.read.accruedTips(), p.tip);
  });

  it("allows zero tips and returns bounded due-payment and payer-schedule pages", async () => {
    const f = await networkHelpers.loadFixture(deployFixture);
    const p = await signedPayment(f, { tip: 0n });
    await register(f, [p]);
    const p2 = await signedPayment(f, { validAfter: p.validAfter + 500n });
    await register(f, [p2]);
    assert.equal(await f.prepaid.read.payerScheduleCount([f.payer.account.address]), 2n);
    assert.deepEqual(await f.prepaid.read.getPayerScheduleIds([f.payer.account.address, 0n, 1n]), [1n]);
    assert.deepEqual(await f.prepaid.read.getPayerScheduleIds([f.payer.account.address, 1n, 100n]), [2n]);
    assert.deepEqual(await f.prepaid.read.getPayerScheduleIds([f.payer.account.address, 999n, 1n]), []);
    await assert.rejects(f.prepaid.read.getPayerScheduleIds([f.payer.account.address, 0n, 101n]), /InvalidBatchSize/);
    await networkHelpers.time.increaseTo(p.validAfter + 1n);
    assert.deepEqual(await f.prepaid.read.getDuePaymentIds([0n, 100n]), [[1n], 3n]);
    assert.deepEqual(await f.prepaid.read.getDuePaymentIds([1n, 1n]), [[1n], 2n]);
    assert.deepEqual(await f.prepaid.read.getDuePaymentIds([2n, 1n]), [[], 3n]);
    assert.deepEqual(await f.prepaid.read.getDuePaymentIds([999n, 100n]), [[], 3n]);
    await assert.rejects(f.prepaid.read.getDuePaymentIds([1n, 0n]), /InvalidBatchSize/);
    await assert.rejects(f.prepaid.read.getDuePaymentIds([1n, 101n]), /InvalidBatchSize/);
    await f.prepaid.write.executePayment([1n]);
    assert.equal(await f.prepaid.read.accruedTips(), 0n);
    assert.equal(await f.usdc.read.balanceOf([f.prepaid.address]), 0n);
    assert.deepEqual(await f.prepaid.read.getDuePaymentIds([1n, 100n]), [[], 3n]);
  });
});
