import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { business } from "@/test/fixtures";

import { OpeningHours } from "./OpeningHours";

const plain = (text: string | null) => (text ?? "").replace(/\s/g, " ");

/** The text of each interval line for a weekday, or ["Closed"]. */
function row(day: string) {
  const details = screen.getByText(day, { selector: "dt" }).nextElementSibling;
  const lines = [...(details?.querySelectorAll("span") ?? [])];
  return lines.length > 0
    ? lines.map((line) => plain(line.textContent))
    : [plain(details?.textContent ?? null)];
}

describe("OpeningHours", () => {
  it("shows a split day in chronological order", () => {
    render(
      <OpeningHours hours={business.hours} timezone={business.timezone} />,
    );
    expect(row("Tuesday")).toEqual([
      "9:00 AM to 1:00 PM",
      "2:00 PM to 6:00 PM",
    ]);
  });

  it("shows a single interval", () => {
    render(
      <OpeningHours hours={business.hours} timezone={business.timezone} />,
    );
    expect(row("Saturday")).toEqual(["9:00 AM to 2:00 PM"]);
  });

  it("marks days without hours as closed", () => {
    render(
      <OpeningHours hours={business.hours} timezone={business.timezone} />,
    );
    expect(row("Monday")).toEqual(["Closed"]);
    expect(row("Sunday")).toEqual(["Closed"]);
  });

  it("states the business timezone explicitly", () => {
    render(
      <OpeningHours hours={business.hours} timezone={business.timezone} />,
    );
    expect(
      screen.getByText(/Eastern Time \(America\/New_York\)/),
    ).toBeInTheDocument();
  });

  it("keeps each time together so it never wraps between the clock time and AM/PM", () => {
    render(
      <OpeningHours hours={business.hours} timezone={business.timezone} />,
    );
    const afternoon = screen.getByText(/2:00.PM to 6:00.PM/);
    expect(afternoon.textContent).toMatch(/2:00 PM to 6:00 PM/);
  });
});
