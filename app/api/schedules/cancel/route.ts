import { bytes32, normalizeScheduleKey } from "@/lib/db/authorization";
import { createPaymentRepository } from "@/lib/db/payments";
import { sessionPayer } from "@/lib/server/auth";
import { confirmedCancellation, recentCancellationHash } from "@/lib/server/cancellation";
import { checkedContext, isCancelled } from "@/lib/server/config";
import { ApiError, apiFailure, appOrigin, json, readJson, sameOrigin } from "@/lib/server/http";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const payer = await sessionPayer(appOrigin(request)), input = await readJson(request);
    let scheduleId, hash;
    try {
      if (typeof input.scheduleId !== "string") throw new Error();
      scheduleId = bytes32(input.scheduleId);
      if (input.transactionHash !== undefined) {
        if (typeof input.transactionHash !== "string") throw new Error();
        hash = bytes32(input.transactionHash);
      }
    } catch { throw new ApiError("Invalid schedule ID or transaction hash."); }
    const context = await checkedContext(), key = normalizeScheduleKey({ ...context, payer, scheduleId });
    const repo = createPaymentRepository(), schedule = await repo.getSchedule(key);
    if (!schedule) throw new ApiError("Schedule not found for your wallet.", 404);
    if (!hash) {
      // Preflight avoids another wallet transaction when cancellation already happened.
      if (!await isCancelled(payer, scheduleId)) return json({ cancelled: false });
      hash = schedule.cancellationTxHash ?? await recentCancellationHash(key) ?? undefined;
      if (!hash) throw new ApiError("This schedule is already cancelled on-chain. Paste its cancellation transaction hash to sync the older receipt.", 409);
    }
    const proof = await confirmedCancellation(key, hash);
    if (!await repo.recordScheduleCancellation(key, proof)) throw new ApiError("Cancellation receipt conflicts with the recorded schedule.", 409);
    return json({ cancelled: true, transactionHash: proof.transactionHash });
  } catch (error) { return apiFailure(error); }
}
