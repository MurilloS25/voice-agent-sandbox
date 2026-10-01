import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { expectNoA11yViolations } from "@/test/axe";
import { appointment, proposal } from "@/test/fixtures";

import { AppointmentSummary } from "./AppointmentSummary";
import { BookingReview } from "./BookingReview";
import { DemoBanner } from "./DemoBanner";

const plain = (text: string | null) => (text ?? "").replace(/\s/g, " ");

function detail(label: string): string {
  const term = screen.getByText(label, { selector: "dt" });
  const definition = term.parentElement?.querySelector("dd");
  return plain(definition?.textContent ?? null);
}

describe("BookingReview", () => {
  it("shows exactly what will be booked, in the business timezone", () => {
    render(<BookingReview proposal={proposal} />);

    expect(detail("Service")).toBe("Flat repair");
    expect(detail("Date")).toBe("Thursday, October 1, 2026");
    expect(detail("Time")).toBe("9:00 AM to 9:30 AM");
    expect(detail("Duration")).toBe("30 min");
    expect(detail("Time zone")).toBe("Eastern Time (America/New_York)");
    expect(detail("Price")).toBe("$15.00");
    expect(detail("Name on booking (fictional)")).toBe("Demo Amber Heron");
  });

  it("says nothing is booked yet and that the time is not held", () => {
    render(<BookingReview proposal={proposal} />);
    expect(screen.getByText(/Nothing has been booked yet/)).toBeInTheDocument();
    expect(screen.getByText(/valid until/)).toHaveTextContent(
      /valid until 8:10 AM/,
    );
    expect(screen.getByText(/not held for you/)).toBeInTheDocument();
  });

  it("uses a description list with machine-readable times", () => {
    const { container } = render(<BookingReview proposal={proposal} />);
    expect(container.querySelector("dl")).not.toBeNull();
    const times = container.querySelectorAll("time");
    expect([...times].map((t) => t.getAttribute("datetime"))).toEqual([
      "2026-10-01T13:00:00Z",
      "2026-10-01T13:30:00Z",
      "2026-09-30T12:10:00Z",
    ]);
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<BookingReview proposal={proposal} />);
    await expectNoA11yViolations(container);
  });
});

describe("AppointmentSummary", () => {
  it("shows the saved record and who confirmed what", () => {
    render(<AppointmentSummary appointment={appointment} />);

    expect(detail("Service")).toBe("Flat repair");
    expect(detail("Time")).toBe("9:00 AM to 9:30 AM");
    expect(detail("Bench")).toBe("Bench 1");
    expect(detail("Booking reference")).toBe(appointment.id);
    expect(
      screen.getByText(/Confirmed and saved by the schedule service/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/You chose this time and confirmed it yourself/),
    ).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <AppointmentSummary appointment={appointment} />,
    );
    await expectNoA11yViolations(container);
  });
});

describe("DemoBanner", () => {
  it("labels the page as a fictional demo", () => {
    render(<DemoBanner />);
    const note = screen.getByRole("complementary", { name: "Demo notice" });
    expect(within(note).getByText(/Fictional demo/)).toBeInTheDocument();
    expect(note).toHaveTextContent(/no personal details are collected/);
  });
});
