import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { availability } from "@/test/fixtures";

import { SlotList } from "./SlotList";

const plain = (text: string | null) => (text ?? "").replace(/\s/g, " ");

describe("SlotList", () => {
  it("lists slot times in the business timezone and labels the timezone", () => {
    render(
      <SlotList
        availability={availability}
        serviceName="Flat repair"
        shopClosed={false}
      />,
    );

    const times = screen
      .getAllByRole("listitem")
      .map((item) => plain(item.textContent));
    expect(times).toEqual(["9:00 AM", "11:30 AM"]);
    expect(
      screen.getByText(/Eastern Time \(America\/New_York\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/2 open start times for Flat repair/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Thursday, October 1, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/takes 30 minutes/)).toBeInTheDocument();
  });

  it("does not offer booking controls because the experience is read-only", () => {
    render(
      <SlotList
        availability={availability}
        serviceName="Flat repair"
        shopClosed={false}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("explains a closed day", () => {
    render(
      <SlotList
        availability={{ ...availability, date: "2026-10-05", slots: [] }}
        serviceName="Flat repair"
        shopClosed
      />,
    );
    expect(
      screen.getByText("The shop is closed on Mondays. Choose another date."),
    ).toBeInTheDocument();
  });

  it("explains a fully booked day differently from a closed day", () => {
    render(
      <SlotList
        availability={{ ...availability, slots: [] }}
        serviceName="Flat repair"
        shopClosed={false}
      />,
    );
    expect(
      screen.getByText(
        /No open times for Flat repair on Thursday, October 1, 2026/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/closed/i)).not.toBeInTheDocument();
  });
});
