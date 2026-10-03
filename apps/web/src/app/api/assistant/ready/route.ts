/**
 * Is the assistant's backend ready? The page asks this before it lets the visitor talk, so a
 * sleeping or restarting API shows "Starting workshop assistant…" instead of a failed turn.
 *
 * It answers with a single word and nothing else. It calls only the API's public readiness path
 * (no provider, no database of its own, no credentials) and never the agent. It is a plain read:
 * it does nothing a visitor could not do by opening the page.
 */
import { getApiReadiness } from "@/lib/api/client";

export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "no-store" } as const;

export async function GET(request: Request): Promise<Response> {
  const state = await getApiReadiness(request.signal);
  return Response.json({ state }, { headers: HEADERS });
}
