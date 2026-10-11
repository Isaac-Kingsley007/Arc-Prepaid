import { cookies } from "next/headers";
import { normalizeAddress } from "@/lib/db/authorization";
import { createSessionRepository, SESSION_COOKIE, setSession } from "../../../lib/server/auth";
import { ApiError, apiFailure, appOrigin, json, readJson, sameOrigin } from "../../../lib/server/http";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    return json({ payer: await createSessionRepository().payer(token, appOrigin(request)) });
  } catch (error) { return apiFailure(error); }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const origin = appOrigin(request), input = await readJson(request), repo = createSessionRepository();
    if (input.action === "challenge") {
      let payer;
      try { payer = normalizeAddress(String(input.payer)); } catch { throw new ApiError("Invalid wallet address."); }
      const old = (await cookies()).get(SESSION_COOKIE)?.value;
      await repo.logout(old);
      const challenge = await repo.challenge(payer, origin);
      await setSession(challenge.token, origin, 300);
      return json({ message: challenge.message });
    }
    if (input.action !== "verify" || typeof input.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(input.signature)) throw new ApiError("Invalid sign-in request.");
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) throw new ApiError("Request a sign-in challenge first.", 401);
    const session = await repo.verify(token, input.signature as `0x${string}`, origin);
    await setSession(session.token, origin, 8 * 3600);
    return json({ payer: session.payer });
  } catch (error) { return apiFailure(error); }
}
export async function DELETE(request: Request) {
  try {
    sameOrigin(request);
    await createSessionRepository().logout((await cookies()).get(SESSION_COOKIE)?.value);
    await setSession("", appOrigin(request), 0);
    return json({ ok: true });
  } catch (error) { return apiFailure(error); }
}
