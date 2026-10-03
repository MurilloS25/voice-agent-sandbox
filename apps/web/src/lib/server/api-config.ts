/**
 * How the web server reaches the API: where it is and the secret it presents.
 *
 * Server only. Neither value is ever sent to the browser or put in a `NEXT_PUBLIC_` variable, and
 * this module refuses to be imported by a Client Component (`server-only`).
 *
 * In production the address must be HTTPS (a loopback address is allowed, so a production build
 * can be tried on a laptop) and the secret must be set: a deployment that lacks either does not
 * call the API at all instead of calling it unauthenticated or in the clear.
 */
import "server-only";

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const MIN_SECRET_CHARS = 32;

export class ApiConfigError extends Error {
  constructor() {
    // A fixed message: it never carries the address or the secret.
    super("The API connection is not configured safely.");
    this.name = "ApiConfigError";
  }
}

function production(): boolean {
  return process.env.NODE_ENV === "production";
}

/** The API's base address without a trailing slash. Throws `ApiConfigError` if it is unsafe. */
export function apiBaseUrl(): string {
  const raw = (process.env.API_BASE_URL ?? DEFAULT_BASE_URL).trim();
  if (!production()) return raw.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiConfigError();
  }
  const loopback = LOOPBACK.has(url.hostname);
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && loopback);
  if (!secure || url.username || url.password || url.search || url.hash) {
    throw new ApiConfigError();
  }
  return raw.replace(/\/+$/, "");
}

/**
 * The shared secret, or undefined when none is configured. Production (other than loopback)
 * requires one of at least 32 characters; anything weaker throws.
 */
export function apiSecret(): string | undefined {
  const secret = process.env.API_SHARED_SECRET?.trim();
  if (!secret) {
    if (production() && !LOOPBACK.has(new URL(apiBaseUrl()).hostname)) {
      throw new ApiConfigError();
    }
    return undefined;
  }
  if (production() && secret.length < MIN_SECRET_CHARS)
    throw new ApiConfigError();
  return secret;
}

/** The headers every API call carries, besides its own. Never logged. */
export function apiAuthHeaders(): Record<string, string> {
  const secret = apiSecret();
  return secret ? { authorization: `Bearer ${secret}` } : {};
}
