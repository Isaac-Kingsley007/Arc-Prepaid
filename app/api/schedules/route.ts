import { createPaymentRepository } from "@/lib/db/payments";
import { sessionPayer } from "@/lib/server/auth";
import { arcClient, checkedContext, isCancelled, paymentContext } from "@/lib/server/config";
import { ApiError, apiFailure, appOrigin, json, readJson, sameOrigin } from "@/lib/server/http";
import { validateUpload } from "@/lib/server/schedules";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const payer = await sessionPayer(appOrigin(request)), context = paymentContext();
    const offset = Number(new URL(request.url).searchParams.get("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiError("Invalid pagination offset.");
    const repo = createPaymentRepository(), schedules = await repo.listPayerSchedules(context, payer, 20, offset);
    const result = await Promise.all(schedules.map(async (s) => ({ scheduleId: s.scheduleId, label: s.label,
      cancelled: Boolean(s.cancellationTxHash), payments: (await repo.listSchedulePayments(s)).map((p) => ({
        occurrence: p.occurrence, payee: p.payee, amount: p.amount, tip: p.tip, validAfter: p.validAfter,
        validBefore: p.validBefore, status: p.status, transactionHash: p.transactionHash,
      })) })));
    // Dashboard DTOs deliberately omit signatures, salts and relayer lease details.
    return json({ payer, schedules: result, nextOffset: schedules.length === 20 ? offset + 20 : null });
  } catch (error) { return apiFailure(error); }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const payer = await sessionPayer(appOrigin(request));
    const input = await readJson(request), context = await checkedContext();
    const upload = await validateUpload(input, context, payer);
    const repo = createPaymentRepository();
    // An uncertain HTTP response must be retryable even if an occurrence executed meanwhile.
    const existing = await repo.getSchedule(upload);
    if (!existing) {
      const [block, cancelled] = await Promise.all([arcClient().getBlock(), isCancelled(payer, upload.scheduleId)]);
      if (cancelled) throw new ApiError("This schedule was cancelled on-chain.");
      if (upload.payments.some((p) => BigInt(p.validAfter) + BigInt(1) <= block.timestamp)) throw new ApiError("The first payment time has passed. Choose a future start time and sign again.");
    }
    const saved = await repo.saveSchedule(upload);
    return json({ scheduleId: saved.scheduleId }, 201);
  } catch (error) { return apiFailure(error); }
}
