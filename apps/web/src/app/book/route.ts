import { NextResponse } from "next/server";

import { assistantHref, sanitizeContext } from "@/lib/assistant-link";

/**
 * `/book` is no longer a way in: a booking starts in the assistant. Old links get a real 307 to
 * it, made before any page renders. Only a well-formed service id survives; a start time or any
 * other value in the URL is dropped, because the agent has to offer times itself.
 * `ConfirmForm`, its Server Action and `POST /v1/appointments` stay in this folder and are
 * reached from the review card inside the chat.
 */
export function GET(request: Request) {
  const url = new URL(request.url);
  const context = sanitizeContext({
    service: url.searchParams.get("service") ?? undefined,
  });
  return NextResponse.redirect(new URL(assistantHref(context), url), 307);
}
