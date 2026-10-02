/**
 * The web tier's response headers.
 *
 * The Content-Security-Policy ships as Report-Only on the first deployment (decision D8): the
 * browser reports what it would block without blocking it, so a mistake cannot break the demo.
 * Enforcing it is a one-word change (`CSP_MODE=enforce`) once a real browser run shows no
 * violations. The policy uses a per-request nonce and no `unsafe-eval` in production.
 * Microphone access stays allowed for this origin, because voice input needs it.
 */

export const STATIC_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "microphone=(self), camera=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export function buildCsp(nonce: string, development: boolean): string {
  const directives = [
    "default-src 'self'",
    // Next.js bootstraps with nonce'd inline scripts; 'strict-dynamic' lets those load the rest.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    // Inline styles are used by the framework and the fonts; no scripts are allowed through them.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // The browser talks only to this origin: the API is reached through the server.
    `connect-src 'self'${development ? " ws: http:" : ""}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (!development) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function cspHeaderName(mode: string | undefined): string {
  return mode === "enforce"
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";
}
