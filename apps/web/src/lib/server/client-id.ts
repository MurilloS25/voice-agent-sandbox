/**
 * An ephemeral, anonymous visitor key for the API's rate limits.
 *
 * The web server is the only place that can know the visitor's address: on Vercel the platform
 * sets `x-vercel-forwarded-for` and overwrites any value a visitor sends (documented by Vercel).
 * The address is turned into a keyed hash (HMAC-SHA256, truncated) with a key that only this
 * server holds, and only that hash is sent to the API, inside the authenticated server-to-server
 * request. The API keeps it in memory for a short window and never logs or stores it.
 *
 * Fail closed: the address is read only when the deployment says where it comes from
 * (`CLIENT_IP_SOURCE=vercel`) *and* the platform confirms it (`VERCEL=1`), and only when the key
 * is set. In every other case there is no key, and the API puts the request in one shared,
 * strict "unattributed" bucket. A header is never trusted merely because it is present.
 *
 * `CLIENT_IP_SOURCE=test` (outside production) reads a plain label from `x-test-client`, so local
 * rehearsals and tests can give each visitor a deterministic key.
 */
import "server-only";

import { createHmac } from "node:crypto";
import { isIP } from "node:net";

export const CLIENT_ID_HEADER = "x-client-id";
const ID_LENGTH = 32;

type HeaderReader = { get(name: string): string | null };

function hash(key: string, value: string): string {
  return createHmac("sha256", key)
    .update(value)
    .digest("hex")
    .slice(0, ID_LENGTH);
}

/** The first address of a forwarded list, if it is a real IP address. */
function firstAddress(value: string | null): string | undefined {
  const first = value?.split(",", 1)[0]?.trim();
  return first && isIP(first) !== 0 ? first : undefined;
}

export function clientId(
  headers: HeaderReader,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const key = env.CLIENT_ID_KEY?.trim();
  if (!key || key.length < 32) return undefined;
  const source = env.CLIENT_IP_SOURCE?.trim();

  if (source === "vercel") {
    if (env.VERCEL !== "1") return undefined; // not on the platform that sets the header
    const address = firstAddress(headers.get("x-vercel-forwarded-for"));
    return address ? hash(key, address) : undefined;
  }
  if (source === "test" && env.NODE_ENV !== "production") {
    const label = headers.get("x-test-client")?.trim();
    return label ? hash(key, label) : undefined;
  }
  return undefined;
}
