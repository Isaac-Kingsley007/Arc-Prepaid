import "server-only";

export class ApiError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function appOrigin(request: Request): string {
  const origin = new URL(process.env.APP_ORIGIN || request.url).origin;
  if (process.env.NODE_ENV === "production" && !process.env.APP_ORIGIN) throw new ApiError("Set APP_ORIGIN on the server.", 503);
  return origin;
}
export function sameOrigin(request: Request) {
  if (request.headers.get("origin") !== appOrigin(request)) throw new ApiError("Request origin does not match this app.", 403);
}
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new ApiError("Send JSON.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError("Missing request body.");
  let length = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 100_000) { await reader.cancel(); throw new ApiError("Request is too large.", 413); }
    chunks.push(value);
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
    return input;
  } catch { throw new ApiError("Invalid JSON object."); }
}
export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
export function apiFailure(error: unknown) {
  // Never send database errors, SQL, connection URLs or RPC credentials to the browser.
  return json({ error: error instanceof ApiError ? error.message : "The server could not complete this request. Check database and contract configuration, then retry." }, error instanceof ApiError ? error.status : 503);
}
