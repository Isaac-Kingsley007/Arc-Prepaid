import { encodeAbiParameters, getAddress, keccak256, recoverTypedDataAddress, toHex, zeroAddress, zeroHash, type Address, type Hex } from "viem";

export const ARC_USDC = "0x3600000000000000000000000000000000000000" as const;
const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1);
export const PAYMENT_NONCE_TYPEHASH = keccak256(toHex(
  "PrePaidPayment(uint256 chainId,address prepaid,address usdc,address payer,bytes32 scheduleId,address payee,uint256 amount,uint256 tip,uint256 validAfter,uint256 validBefore,bytes32 salt)",
));
export const receiveAuthorizationTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" },
    { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
} as const;

export type ChainContext = { chainId: number; prepaid: Address; usdc: Address };
export type ScheduleKey = ChainContext & { payer: Address; scheduleId: Hex };
/** Decimal strings are lossless and safe to send through JSON APIs. */
export type SignedPayment = {
  payee: Address; amount: string; tip: string; validAfter: string; validBefore: string;
  salt: Hex; v: number; r: Hex; s: Hex;
};

export function normalizeAddress(value: string): Address {
  return getAddress(value).toLowerCase() as Address;
}
export function bytes32(value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("Expected a bytes32 hex value");
  return value.toLowerCase() as Hex;
}
export function uint256(value: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) > MAX_UINT256) {
    throw new Error("Expected a canonical uint256 decimal string");
  }
  return value;
}
export function normalizeContext(context: ChainContext): ChainContext {
  if (![5042002, 5042].includes(context.chainId)) throw new Error("Only Arc testnet/mainnet are supported");
  const prepaid = normalizeAddress(context.prepaid);
  const usdc = normalizeAddress(context.usdc);
  if (usdc !== ARC_USDC || prepaid === zeroAddress || prepaid === usdc) throw new Error("Invalid Arc contract/token address");
  return { chainId: context.chainId, prepaid, usdc };
}
export function normalizeScheduleKey(key: ScheduleKey): ScheduleKey {
  const payer = normalizeAddress(key.payer);
  const scheduleId = bytes32(key.scheduleId);
  if (payer === zeroAddress || scheduleId === zeroHash) throw new Error("Payer and schedule ID must be nonzero");
  return { ...normalizeContext(key), payer, scheduleId };
}
export function normalizePayment(key: ScheduleKey, input: SignedPayment): SignedPayment {
  const payee = normalizeAddress(input.payee);
  const amount = uint256(input.amount), tip = uint256(input.tip);
  const validAfter = uint256(input.validAfter), validBefore = uint256(input.validBefore);
  if (payee === zeroAddress || payee === key.prepaid || payee === key.usdc || amount === "0"
    || BigInt(amount) + BigInt(tip) > MAX_UINT256 || BigInt(validAfter) >= BigInt(validBefore)) throw new Error("Invalid payment instructions");
  if (input.v !== 27 && input.v !== 28) throw new Error("Signature v must be 27 or 28");
  return { payee, amount, tip, validAfter, validBefore, salt: bytes32(input.salt), v: input.v, r: bytes32(input.r), s: bytes32(input.s) };
}

/** Identical to PrePaid.getPaymentNonce; signature fields are intentionally excluded. */
export function getPaymentNonce(key: ScheduleKey, payment: SignedPayment): Hex {
  return keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" },
    { type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" },
    { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" },
  ], [PAYMENT_NONCE_TYPEHASH, BigInt(key.chainId), key.prepaid, key.usdc, key.payer, key.scheduleId,
    payment.payee, BigInt(payment.amount), BigInt(payment.tip), BigInt(payment.validAfter), BigInt(payment.validBefore), payment.salt]));
}

/** EOA signatures for the documented Arc USDC domain; chain integration must check DOMAIN_SEPARATOR. */
export async function verifyPaymentSignature(key: ScheduleKey, payment: SignedPayment): Promise<Hex> {
  const nonce = getPaymentNonce(key, payment);
  const signer = await recoverTypedDataAddress({
    domain: { name: "USDC", version: "2", chainId: key.chainId, verifyingContract: key.usdc },
    types: receiveAuthorizationTypes, primaryType: "ReceiveWithAuthorization",
    message: { from: key.payer, to: key.prepaid, value: BigInt(payment.amount) + BigInt(payment.tip),
      validAfter: BigInt(payment.validAfter), validBefore: BigInt(payment.validBefore), nonce },
    signature: { v: BigInt(payment.v), r: payment.r, s: payment.s },
  });
  if (normalizeAddress(signer) !== key.payer) throw new Error("USDC authorization signature does not match its payer/instructions");
  return nonce;
}

export function toContractPayment(key: ScheduleKey, payment: SignedPayment) {
  return { payer: key.payer, scheduleId: key.scheduleId, payee: payment.payee,
    amount: BigInt(payment.amount), tip: BigInt(payment.tip),
    validAfter: BigInt(payment.validAfter), validBefore: BigInt(payment.validBefore),
    salt: payment.salt, v: payment.v, r: payment.r, s: payment.s };
}
