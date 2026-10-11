import "server-only";
import { bytes32, normalizePayment, normalizeScheduleKey, type ChainContext, type SignedPayment } from "../db/authorization";
import { verifyPaymentSignature } from "../db/authorization";
import type { Address } from "viem";
import type { PaymentUpload } from "../payments";
import { ApiError } from "./http";

/** Client context, payer and routing data are never trusted merely because a wallet is connected. */
export async function validateUpload(input: Record<string, unknown>, context: ChainContext, payer: Address): Promise<PaymentUpload> {
  try {
    if (input.chainId !== context.chainId || input.prepaid !== context.prepaid || input.usdc !== context.usdc || input.payer !== payer) throw new Error();
    if (typeof input.label !== "string" || input.label.length > 120 || !Array.isArray(input.payments)
      || input.payments.length < 1 || input.payments.length > 50 || typeof input.scheduleId !== "string") throw new Error();
    const key = normalizeScheduleKey({ ...context, payer, scheduleId: bytes32(input.scheduleId) });
    const payments = input.payments.map((p) => {
      if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error();
      return normalizePayment(key, p as SignedPayment);
    });
    // Check signatures here for useful 400 responses; the repository verifies again before writing.
    await Promise.all(payments.map((p) => verifyPaymentSignature(key, p)));
    return { ...key, label: input.label, payments };
  } catch { throw new ApiError("Invalid schedule or signature. The signed instructions must belong to your signed-in wallet and configured contract."); }
}
