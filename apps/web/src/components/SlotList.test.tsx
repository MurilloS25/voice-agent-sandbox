import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { expectNoA11yViolations } from "@/test/axe";
import { availability } from "@/test/fixtures";

import { SlotList } from "./SlotList";

const plain = (text: string | null) => (text ?? "").replace(/\s/g, " ");

describe("SlotList", () => {
  it("lists slot times in the business timezone and labels the timezone", () => {
    render(
      <SlotList
        availability={availability}
        serviceId="flat-repair"
        serviceName="Flat repair"
        shopClosed={false}
      />,
    );

    const times = screen
      .getAllByRole("listitem")
      .map((item) => plain(item.querySelector("time")?.textContent ?? null));
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

  it("shows times as text and sends the visitor to the assistant, carrying no time", () => {
    render(
      <SlotList
        availability={availability}
        serviceId="flat-repair"
        serviceName="Flat repair"
        shopClosed={false}
      />,
    );

    // One link, to the assistant, with the service and the day only. No time travels in a URL.
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute(
      "href",
      "/assistant?service=flat-repair&date=2026-10-01",
    );
    expect(links[0]).toHaveAccessibleName(
      "Ask the assistant to book Flat repair",
    );
    expect(document.body.innerHTML).not.toContain("/book");
    expect(document.body.innerHTML).not.toContain("start=");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(
      screen.getByText(/nothing is booked until you confirm/),
    ).toBeInTheDocument();
  });

  it("explains a closed day", () => {
    render(
      <SlotList
        availability={{ ...availability, date: "2026-10-05", slots: [] }}
        serviceId="flat-repair"
        serviceName="Flat repair"
        shopClosed
      />,
    );
    expect(
      screen.getByText("The shop is closed on Mondays. Choose another date."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Ask the assistant for other options" }),
    ).toHaveAttribute("href", "/assistant?service=flat-repair&date=2026-10-05");
  });

  it("explains a fully booked day differently from a closed day", () => {
    render(
      <SlotList
        availability={{ ...availability, slots: [] }}
        serviceId="flat-repair"
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

  it("has no accessibility violations", async () => {
    const { container } = render(
      <SlotList
        availability={availability}
        serviceId="flat-repair"
        serviceName="Flat repair"
        shopClosed={false}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
