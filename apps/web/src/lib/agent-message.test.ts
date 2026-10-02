import { describe, expect, it } from "vitest";

import { MAX_MESSAGE_LENGTH, normalizeMessage } from "./agent-message";

describe("normalizeMessage", () => {
  it("trims and keeps a newline", () => {
    expect(normalizeMessage("  hello\nthere  ")).toBe("hello\nthere");
  });

  it.each([
    "",
    "   ",
    "\n\n",
    "x".repeat(MAX_MESSAGE_LENGTH + 1),
    "a\u0000b",
    "a\rb",
    "a\tb",
    "a\u007fb",
  ])("refuses %j", (value) => {
    expect(normalizeMessage(value)).toBeUndefined();
  });

  it("accepts exactly the limit", () => {
    expect(normalizeMessage("x".repeat(MAX_MESSAGE_LENGTH))).toHaveLength(500);
  });
});
