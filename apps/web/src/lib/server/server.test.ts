import { afterEach, describe, expect, it, vi } from "vitest";

import { apiAuthHeaders, apiBaseUrl, apiSecret } from "./api-config";
import { clientId } from "./client-id";
import { buildCsp, cspHeaderName, STATIC_HEADERS } from "./security-headers";

const SECRET = "s".repeat(40);
const KEY = "k".repeat(40);

afterEach(() => vi.unstubAllEnvs());

describe("api-config in production", () => {
  it("accepts https and loopback http only", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("API_BASE_URL", "https://api.example.invalid/");
    expect(apiBaseUrl()).toBe("https://api.example.invalid");
    vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8000");
    expect(apiBaseUrl()).toBe("http://127.0.0.1:8000");
    for (const bad of [
      "http://api.example.invalid",
      "https://user:pw@api.example.invalid",
      "https://api.example.invalid/?x=1",
      "not a url",
    ]) {
      vi.stubEnv("API_BASE_URL", bad);
      expect(() => apiBaseUrl()).toThrow("not configured safely");
    }
  });

  it("requires a long secret unless the API is on loopback", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("API_BASE_URL", "https://api.example.invalid");
    vi.stubEnv("API_SHARED_SECRET", "");
    expect(() => apiSecret()).toThrow();
    vi.stubEnv("API_SHARED_SECRET", "short");
    expect(() => apiSecret()).toThrow();
    vi.stubEnv("API_SHARED_SECRET", SECRET);
    expect(apiAuthHeaders()).toEqual({ authorization: `Bearer ${SECRET}` });
  });

  it("the error message never contains the address or the secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("API_BASE_URL", "http://leaky.example.invalid");
    vi.stubEnv("API_SHARED_SECRET", SECRET);
    try {
      apiBaseUrl();
    } catch (error) {
      expect(String(error)).not.toContain("leaky");
      expect(String(error)).not.toContain(SECRET);
    }
  });

  it("outside production no secret is fine", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("API_SHARED_SECRET", "");
    expect(apiAuthHeaders()).toEqual({});
  });
});

describe("clientId", () => {
  const headers = (map: Record<string, string>) => ({
    get: (name: string) => map[name] ?? null,
  });

  it("hashes the platform address with the key, never exposing it", () => {
    const env = { CLIENT_ID_KEY: KEY, CLIENT_IP_SOURCE: "vercel", VERCEL: "1" };
    const a = clientId(
      headers({ "x-vercel-forwarded-for": "203.0.113.7" }),
      env,
    );
    const b = clientId(
      headers({ "x-vercel-forwarded-for": "203.0.113.8" }),
      env,
    );
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain("203");
    expect(a).not.toBe(b);
    expect(
      clientId(headers({ "x-vercel-forwarded-for": "203.0.113.7" }), env),
    ).toBe(a);
  });

  it("fails closed without key, source, platform or a real address", () => {
    const good = { "x-vercel-forwarded-for": "203.0.113.7" };
    const env = { CLIENT_ID_KEY: KEY, CLIENT_IP_SOURCE: "vercel", VERCEL: "1" };
    expect(
      clientId(headers(good), { ...env, CLIENT_ID_KEY: undefined }),
    ).toBeUndefined();
    expect(
      clientId(headers(good), { ...env, CLIENT_ID_KEY: "short" }),
    ).toBeUndefined();
    expect(
      clientId(headers(good), { ...env, CLIENT_IP_SOURCE: undefined }),
    ).toBeUndefined();
    expect(
      clientId(headers(good), { ...env, VERCEL: undefined }),
    ).toBeUndefined();
    expect(
      clientId(headers({ "x-vercel-forwarded-for": "junk" }), env),
    ).toBeUndefined();
  });

  it("ignores spoofable generic headers", () => {
    const env = { CLIENT_ID_KEY: KEY, CLIENT_IP_SOURCE: "vercel", VERCEL: "1" };
    expect(
      clientId(
        headers({
          "x-forwarded-for": "203.0.113.7",
          "x-real-ip": "203.0.113.7",
        }),
        env,
      ),
    ).toBeUndefined();
  });

  it("the test source is never honoured in production", () => {
    const env = { CLIENT_ID_KEY: KEY, CLIENT_IP_SOURCE: "test" };
    expect(
      clientId(headers({ "x-test-client": "a" }), {
        ...env,
        NODE_ENV: "production",
      }),
    ).toBeUndefined();
    expect(
      clientId(headers({ "x-test-client": "a" }), { ...env, NODE_ENV: "test" }),
    ).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("security headers", () => {
  it("builds a strict production policy with a nonce and no unsafe-eval", () => {
    const csp = buildCsp("abc", false);
    expect(csp).toContain("'nonce-abc'");
    expect(csp).not.toContain("unsafe-eval");
    for (const part of [
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "connect-src 'self'",
    ]) {
      expect(csp).toContain(part);
    }
  });

  it("allows eval only in development", () => {
    expect(buildCsp("abc", true)).toContain("'unsafe-eval'");
  });

  it("is report-only unless explicitly enforced", () => {
    expect(cspHeaderName(undefined)).toBe(
      "Content-Security-Policy-Report-Only",
    );
    expect(cspHeaderName("enforce")).toBe("Content-Security-Policy");
  });

  it("keeps the microphone for this origin and blocks embedding", () => {
    expect(STATIC_HEADERS["Permissions-Policy"]).toContain("microphone=(self)");
    expect(STATIC_HEADERS["X-Frame-Options"]).toBe("DENY");
    expect(STATIC_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(STATIC_HEADERS["Referrer-Policy"]).toBeTruthy();
  });
});
