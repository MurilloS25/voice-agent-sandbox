import { NextResponse, type NextRequest } from "next/server";

import {
  buildCsp,
  cspHeaderName,
  STATIC_HEADERS,
} from "@/lib/server/security-headers";

/** Adds the security headers, with a fresh nonce for the Content-Security-Policy, to pages. */
export function proxy(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, process.env.NODE_ENV !== "production");
  const name = cspHeaderName(process.env.CSP_MODE);

  // Next.js reads the nonce from the request's CSP header and applies it to its own scripts.
  const forwarded = new Headers(request.headers);
  forwarded.set("x-nonce", nonce);
  forwarded.set(name, csp);

  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set(name, csp);
  for (const [key, value] of Object.entries(STATIC_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
