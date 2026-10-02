import { beforeEach, describe, expect, it, vi } from "vitest";

const { getApiReadiness } = vi.hoisted(() => ({ getApiReadiness: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ getApiReadiness }));

import { GET } from "./route";

beforeEach(() => getApiReadiness.mockReset());

describe("GET /api/assistant/ready", () => {
  it.each(["ready", "starting", "unreachable"])(
    "reports %s and nothing else",
    async (state) => {
      getApiReadiness.mockResolvedValue(state);
      const response = await GET(
        new Request("http://x.test/api/assistant/ready"),
      );
      expect(await response.json()).toEqual({ state });
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );
});
