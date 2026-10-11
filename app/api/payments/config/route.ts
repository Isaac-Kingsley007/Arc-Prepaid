import { checkedContext } from "@/lib/server/config";
import { apiFailure, json } from "@/lib/server/http";
export const runtime = "nodejs";
export async function GET() {
  try { return json(await checkedContext()); } catch (error) { return apiFailure(error); }
}
