import { bytes32 } from "@/lib/db/authorization";
import { createPaymentRepository } from "@/lib/db/payments";
import { claimBatch, discover, reconcile, settleReplacement } from "@/lib/relayer/service";
import { sessionPayer } from "@/lib/server/auth";
import { arcClient, checkedContext } from "@/lib/server/config";
import { ApiError, apiFailure, appOrigin, json, readJson, sameOrigin } from "@/lib/server/http";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await sessionPayer(appOrigin(request));
    const context = await checkedContext(), repo = createPaymentRepository(), client = arcClient();
    // Receipt uncertainty never releases submitted work. Reconcile a bounded number each refresh.
    const submitted = await repo.listSubmittedPayments(context, 100);
    for (const hash of [...new Set(submitted.map((p) => p.transactionHash!))].slice(0, 5)) {
      try { await reconcile(context, hash, repo, client); } catch { /* Keep the submitted hash for another attempt. */ }
      finally { await repo.touchSubmittedHash(context, hash); }
    }
    return json({ context, candidates: await discover(context, repo, client) });
  } catch (error) { return apiFailure(error); }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const executor = await sessionPayer(appOrigin(request)), input = await readJson(request);
    const context = await checkedContext(), repo = createPaymentRepository(), client = arcClient();
    if (input.action === "claim") {
      const count = input.count;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 10) throw new ApiError("Choose between 1 and 10 payments.");
      return json(await claimBatch(context, executor, count, repo, client));
    }
    const token = input.claimToken;
    if (token !== undefined && (typeof token !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(token))) throw new ApiError("Invalid claim token.");
    if (input.action === "release") {
      if (typeof token !== "string") throw new ApiError("Missing claim token.");
      const rows = await repo.getRelayerClaim(context, token, executor);
      if (!rows.length) throw new ApiError("Claim not found for your wallet.", 404);
      // The client only uses this before broadcasting or after an explicit wallet rejection.
      await repo.releaseClaimPayments(token, rows.filter((p) => p.status === "leased").map((p) => p.id), "Relayer released an unsubmitted batch");
      return json({ ok: true });
    }
    if (input.action !== "sync" || typeof input.transactionHash !== "string") throw new ApiError("Invalid relayer action.");
    let hash;
    try { hash = bytes32(input.transactionHash); } catch { throw new ApiError("Invalid transaction hash."); }
    if (typeof input.originalHash === "string") {
      let original;
      try { original = bytes32(input.originalHash); } catch { throw new ApiError("Invalid original hash."); }
      return json(await settleReplacement(context, original, hash, executor, token as string | undefined, repo, client));
    }
    return json(await reconcile(context, hash, repo, client, executor, token as string | undefined));
  } catch (error) { return apiFailure(error); }
}
