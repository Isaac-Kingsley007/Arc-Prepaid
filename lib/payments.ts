import { parseSignature, toHex, zeroHash, type Hex } from "viem";
import { getPaymentNonce, normalizePayment, receiveAuthorizationTypes, type ChainContext, type ScheduleKey, type SignedPayment } from "./db/authorization";
import { buildSchedule, units, validateInput, type ScheduleInput } from "../app/schedule";

export type PaymentUpload = ScheduleKey & { label: string; payments: SignedPayment[] };
export type DashboardSchedule = {
  scheduleId: Hex; label: string; cancelled: boolean;
  payments: { occurrence: number; payee: string; amount: string; tip: string; validAfter: string; validBefore: string; status: string; transactionHash: string | null }[];
};
export function randomBytes32(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}
export function preparePayments(input: ScheduleInput, context: ChainContext, payer: ScheduleKey["payer"]): PaymentUpload {
  if (Object.keys(validateInput(input)).length) throw new Error("Review the payment details and choose a future start time.");
  const dates = buildSchedule(input).dates;
  const key = { ...context, payer, scheduleId: randomBytes32() };
  const payments = dates.map((date, index) => {
    const start = Math.floor(date.getTime() / 1000);
    const next = dates[index + 1];
    // EIP-3009 boundaries are strict. start-1 allows execution at the displayed second.
    const end = Math.min(start + 86400, next ? Math.floor(next.getTime() / 1000) : Infinity);
    return normalizePayment(key, { payee: input.payee.trim() as SignedPayment["payee"], amount: units(input.amount)!.toString(),
      tip: units(input.tip || "0")!.toString(), validAfter: String(start - 1), validBefore: String(end),
      salt: randomBytes32(), v: 27, r: zeroHash, s: zeroHash });
  });
  return { ...key, label: input.label.trim(), payments };
}
export function authorizationMessage(key: ScheduleKey, payment: SignedPayment) {
  return { domain: { name: "USDC", version: "2", chainId: key.chainId, verifyingContract: key.usdc },
    types: receiveAuthorizationTypes, primaryType: "ReceiveWithAuthorization" as const,
    message: { from: key.payer, to: key.prepaid, value: BigInt(payment.amount) + BigInt(payment.tip),
      validAfter: BigInt(payment.validAfter), validBefore: BigInt(payment.validBefore), nonce: getPaymentNonce(key, payment) } };
}
export function attachSignature(payment: SignedPayment, signature: Hex): SignedPayment {
  const { v, r, s } = parseSignature(signature);
  return { ...payment, v: Number(v), r, s };
}
