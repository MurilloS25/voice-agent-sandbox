import { describe, expect, it } from "vitest";

import {
  assistantHref,
  draftFor,
  isCalendarDate,
  sanitizeContext,
} from "./assistant-link";

describe("assistantHref", () => {
  it("is plain /assistant without context", () => {
    expect(assistantHref()).toBe("/assistant");
  });

  it("carries a service and a date", () => {
    expect(assistantHref({ service: "flat-repair", date: "2026-10-01" })).toBe(
      "/assistant?service=flat-repair&date=2026-10-01",
    );
  });

  it("drops anything that is not a service id or a real date", () => {
    expect(
      assistantHref({ service: "Flat Repair?x=1", date: "2026-02-30" }),
    ).toBe("/assistant");
  });
});

describe("sanitizeContext", () => {
  it("never passes through other keys such as a start time", () => {
    const context = sanitizeContext({
      service: "flat-repair",
      date: "2026-10-01",
      start: "2026-10-01T13:00:00Z",
    } as { service: string; date: string });
    expect(Object.keys(context).sort()).toEqual(["date", "service"]);
  });
});

describe("isCalendarDate", () => {
  it.each(["2026-13-01", "2026-10-1", "tomorrow", ""])("rejects %s", (v) => {
    expect(isCalendarDate(v)).toBe(false);
  });
});

describe("draftFor", () => {
  it("writes a question, not a booking", () => {
    expect(draftFor({ serviceName: "Flat repair", date: "2026-10-01" })).toBe(
      "Do you have time for Flat repair on Thursday, October 1, 2026?",
    );
    expect(draftFor({})).toBe("");
  });
});
