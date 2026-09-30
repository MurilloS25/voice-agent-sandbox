import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { business, services } from "@/test/fixtures";

import { AvailabilityLookup } from "./AvailabilityLookup";

function renderLookup(
  props: Partial<Parameters<typeof AvailabilityLookup>[0]> = {},
) {
  return render(
    <AvailabilityLookup
      services={services}
      bookingWindow={business.booking_window}
      {...props}
    />,
  );
}

describe("AvailabilityLookup", () => {
  it("offers every service as an option, after a disabled placeholder", () => {
    renderLookup();
    const select = screen.getByLabelText("Service");
    const options = within(select).getAllByRole("option");

    expect(options.map((o) => o.textContent)).toEqual([
      "Choose a service",
      "Flat repair",
      "Standard tune-up",
    ]);
    expect(options[0]).toBeDisabled();
    expect(select).toBeRequired();
  });

  it("bounds the date field by the booking window", () => {
    renderLookup();
    const date = screen.getByLabelText("Date");

    expect(date).toHaveAttribute("min", "2026-09-30");
    expect(date).toHaveAttribute("max", "2026-10-14");
    expect(date).toBeRequired();
  });

  it("pre-fills the current selection", () => {
    renderLookup({
      selectedService: "standard-tune-up",
      selectedDate: "2026-10-02",
    });

    expect(screen.getByLabelText("Service")).toHaveValue("standard-tune-up");
    expect(screen.getByLabelText("Date")).toHaveValue("2026-10-02");
  });

  it("submits as a GET form so the selection lives in the URL", () => {
    const { container } = renderLookup();
    const form = container.querySelector("form");

    expect(form).toHaveAttribute("method", "get");
    expect(form).toHaveAttribute("action", "/#availability");
    expect(
      screen.getByRole("button", { name: "Show open times" }),
    ).toBeInTheDocument();
  });

  it("renders the results area under the form", () => {
    renderLookup({ children: <p>Results go here</p> });

    expect(screen.getByText("Results go here")).toBeInTheDocument();
    // The form reloads the page, and notices announce themselves with role="alert",
    // so the results area must not be a second live region.
    expect(
      screen.getByText("Results go here").parentElement,
    ).not.toHaveAttribute("aria-live");
  });

  it("shows the placeholder, not the first service, when the URL names an unknown service", () => {
    renderLookup({ selectedService: "nope", selectedDate: "2026-10-02" });

    expect(screen.getByLabelText("Service")).toHaveValue("");
    expect(screen.getByLabelText("Date")).toHaveValue("2026-10-02");
  });
});
