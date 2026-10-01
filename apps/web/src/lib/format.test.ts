import { describe, expect, it } from "vitest";

import {
  formatCalendarDate,
  formatClockTime,
  formatDuration,
  formatPrice,
  formatSlotTime,
  formatTimezoneLabel,
  localDateOf,
  tryLocalDateOf,
  weekdayIndex,
} from "./format";

// Newer ICU versions put a narrow no-break space before AM/PM.
const plain = (text: string) => text.replace(/\s/g, " ");

describe("formatPrice", () => {
  it("formats USD minor units", () => {
    expect(formatPrice({ amount_minor: 1500, currency: "USD" })).toBe("$15.00");
    expect(formatPrice({ amount_minor: 22000, currency: "USD" })).toBe(
      "$220.00",
    );
  });

  it("derives fraction digits from the currency instead of assuming cents", () => {
    expect(plain(formatPrice({ amount_minor: 1500, currency: "JPY" }))).toBe(
      "¥1,500",
    );
  });
});

describe("formatPrice with a bad currency code", () => {
  it("does not throw for a malformed code and still shows the amount and the code", () => {
    expect(() =>
      formatPrice({ amount_minor: 1500, currency: "NOT-A-CURRENCY" }),
    ).not.toThrow();
    expect(formatPrice({ amount_minor: 1500, currency: "US" })).toBe(
      "15.00 US",
    );
  });

  it("shows just the amount when the code is empty", () => {
    expect(formatPrice({ amount_minor: 1500, currency: "" })).toBe("15.00");
  });

  it("truncates an unreasonably long code", () => {
    expect(formatPrice({ amount_minor: 99, currency: "X".repeat(40) })).toBe(
      "0.99 XXXXXXXX",
    );
  });

  it("accepts a lowercase but valid code", () => {
    expect(formatPrice({ amount_minor: 1500, currency: "usd" })).toBe("$15.00");
  });
});

describe("formatDuration", () => {
  it.each([
    [30, "30 min"],
    [60, "1 hr"],
    [90, "1 hr 30 min"],
    [240, "4 hr"],
  ])("formats %i minutes", (minutes, expected) => {
    expect(formatDuration(minutes)).toBe(expected);
  });
});

describe("formatSlotTime", () => {
  it("converts UTC to the business timezone under daylight time", () => {
    expect(
      plain(formatSlotTime("2026-10-10T13:00:00Z", "America/New_York")),
    ).toBe("9:00 AM");
  });

  it("converts UTC to the business timezone under standard time", () => {
    expect(
      plain(formatSlotTime("2026-11-07T14:00:00Z", "America/New_York")),
    ).toBe("9:00 AM");
  });

  it("follows the spring-forward jump", () => {
    expect(
      plain(formatSlotTime("2026-03-08T06:30:00Z", "America/New_York")),
    ).toBe("1:30 AM");
    expect(
      plain(formatSlotTime("2026-03-08T07:00:00Z", "America/New_York")),
    ).toBe("3:00 AM");
  });
});

describe("date helpers", () => {
  it("formats opening times", () => {
    expect(plain(formatClockTime("09:00"))).toBe("9:00 AM");
    expect(plain(formatClockTime("14:30"))).toBe("2:30 PM");
  });

  it("formats calendar dates without timezone drift", () => {
    expect(formatCalendarDate("2026-10-01")).toBe("Thursday, October 1, 2026");
  });

  it("numbers weekdays from Monday like the API", () => {
    expect(weekdayIndex("2026-10-05")).toBe(0); // Monday
    expect(weekdayIndex("2026-10-10")).toBe(5); // Saturday
    expect(weekdayIndex("2026-10-11")).toBe(6); // Sunday
  });

  it("labels the timezone with its IANA name", () => {
    expect(formatTimezoneLabel("America/New_York")).toBe(
      "Eastern Time (America/New_York)",
    );
  });
});

describe("localDateOf", () => {
  it("returns the calendar date in the given timezone, not in UTC", () => {
    // 02:00 UTC on 2 October is still the evening of 1 October in New York.
    expect(localDateOf("2026-10-02T02:00:00Z", "America/New_York")).toBe(
      "2026-10-01",
    );
    expect(localDateOf("2026-10-02T02:00:00Z", "UTC")).toBe("2026-10-02");
    expect(localDateOf("2026-10-01T13:00:00Z", "America/New_York")).toBe(
      "2026-10-01",
    );
  });

  it("handles the daylight-saving change day", () => {
    expect(localDateOf("2026-11-01T05:30:00Z", "America/New_York")).toBe(
      "2026-11-01",
    );
  });
});

describe("tryLocalDateOf", () => {
  it("returns the local date for a valid instant", () => {
    expect(tryLocalDateOf("2026-10-01T13:00:00Z", "America/New_York")).toBe(
      "2026-10-01",
    );
  });

  it.each(["nope", "", "2026-13-45T99:99:99Z"])(
    "returns undefined instead of throwing for %j",
    (value) => {
      expect(tryLocalDateOf(value, "America/New_York")).toBeUndefined();
    },
  );
});
