import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { services } from "@/test/fixtures";

import { ServiceList } from "./ServiceList";

describe("ServiceList", () => {
  it("lists each service with its description, duration, and formatted price", () => {
    render(<ServiceList services={services} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(
      within(items[0]).getByRole("heading", { name: "Flat repair" }),
    ).toBeInTheDocument();
    expect(within(items[0]).getByText("$15.00")).toBeInTheDocument();
    expect(within(items[0]).getByText("30 min")).toBeInTheDocument();
    expect(within(items[1]).getByText("$85.00")).toBeInTheDocument();
    expect(within(items[1]).getByText("1 hr 30 min")).toBeInTheDocument();
  });

  it("formats prices with the currency the API returned", () => {
    render(
      <ServiceList
        services={[
          { ...services[0], price: { amount_minor: 1500, currency: "EUR" } },
        ]}
      />,
    );
    expect(screen.getByText("€15.00")).toBeInTheDocument();
  });

  it("shows an empty state when there are no services", () => {
    render(<ServiceList services={[]} />);

    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByText(/no services listed/i)).toBeInTheDocument();
  });

  it("still renders every service when one price has an invalid currency code", () => {
    render(
      <ServiceList
        services={[
          {
            ...services[0],
            price: { amount_minor: 1500, currency: "XX-YY" },
          },
          services[1],
        ]}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("15.00 XX-YY")).toBeInTheDocument();
    expect(screen.getByText("$85.00")).toBeInTheDocument();
  });
});

describe("ServiceList: asking the assistant", () => {
  it("sends each service to the assistant with only its id", () => {
    render(<ServiceList services={services} />);
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/assistant?service=flat-repair",
      "/assistant?service=standard-tune-up",
    ]);
    expect(links[0]).toHaveAccessibleName(
      "Ask the assistant about this: Flat repair",
    );
  });
});
