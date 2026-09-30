import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ApiUnavailableNotice, ErrorNotice, describeError } from "./Notices";

describe("ApiUnavailableNotice", () => {
  it("is announced as an alert and tells the user what to do", () => {
    render(<ApiUnavailableNotice />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The schedule service isn't responding");
    expect(alert).toHaveTextContent("Reload the page");
  });
});

describe("ErrorNotice", () => {
  it("is announced as an alert with guidance for the error code", () => {
    render(
      <ErrorNotice
        code="service_not_found"
        message="No service with id 'nope'."
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong");
    expect(alert).toHaveTextContent("Choose one from the menu");
    expect(alert).not.toHaveTextContent("nope");
  });

  it.each([
    ["validation_error", "Choose a service and a valid date, then try again."],
    ["date_out_of_range", "Pick a date inside the window."],
    [
      "internal_error",
      "The schedule service returned an error. Try again in a moment.",
    ],
  ])("describes %s", (code, expected) => {
    expect(describeError(code, "Pick a date inside the window.")).toBe(
      expected,
    );
  });
});
