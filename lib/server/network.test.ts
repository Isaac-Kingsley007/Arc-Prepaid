import assert from "node:assert/strict";
import { test } from "node:test";
import { arcNetwork } from "../network";
import { paymentContext } from "./config";
import { usdcDomainSeparator } from "../db/authorization";

test("mainnet is the default; signing domains and network settings remain distinct", () => {
  assert.equal(arcNetwork().id, 5042);
  assert.equal(arcNetwork("testnet").id, 5042002);
  assert.equal(arcNetwork().rpcUrls.default.http[0], "https://rpc.mainnet.arc.io");
  assert.notEqual(usdcDomainSeparator(5042), usdcDomainSeparator(5042002));
  assert.throws(() => arcNetwork("unknown"), /must be mainnet or testnet/);
});

test("mainnet cannot fall back to a testnet deployment address", () => {
  const original = process.env.PREPAID_CONTRACT_ADDRESS;
  try {
    delete process.env.PREPAID_CONTRACT_ADDRESS;
    assert.throws(() => paymentContext(), /Set PREPAID_CONTRACT_ADDRESS/);
    process.env.PREPAID_CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111111";
    assert.equal(paymentContext().chainId, 5042);
  } finally {
    if (original === undefined) delete process.env.PREPAID_CONTRACT_ADDRESS;
    else process.env.PREPAID_CONTRACT_ADDRESS = original;
  }
});
