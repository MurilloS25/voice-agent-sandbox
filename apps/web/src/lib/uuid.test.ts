import { afterEach, describe, expect, it, vi } from "vitest";

import { newUuid } from "./uuid";

const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

describe("newUuid", () => {
  it("uses crypto.randomUUID when the browser has it", () => {
    const randomUUID = vi.fn(() => "11111111-1111-4111-8111-111111111111");
    vi.stubGlobal("crypto", { randomUUID, getRandomValues: vi.fn() });
    expect(newUuid()).toBe("11111111-1111-4111-8111-111111111111");
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("falls back to a valid v4 id without it", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(255),
    });
    expect(newUuid()).toMatch(V4);
  });

  it("makes different ids", () => {
    expect(newUuid()).not.toBe(newUuid());
    expect(newUuid()).toMatch(V4);
  });
});
