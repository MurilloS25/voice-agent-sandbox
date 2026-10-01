import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoA11yViolations } from "@/test/axe";

import { ConfirmForm } from "./ConfirmForm";
import type { BookingActionState } from "./state";

const { confirmBooking } = vi.hoisted(() => ({ confirmBooking: vi.fn() }));
vi.mock("./actions", () => ({ confirmBooking }));

const TOKEN = "v1.payload.signature";
const REVIEW = "/book?service=flat-repair&start=2026-10-01T13%3A00%3A00Z";
const OPEN_TIMES = "/?service=flat-repair&date=2026-10-01#availability";

function setup() {
  return render(
    <ConfirmForm
      token={TOKEN}
      reviewHref={REVIEW}
      availabilityHref={OPEN_TIMES}
    />,
  );
}

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button"));
  });
}

beforeEach(() => {
  confirmBooking.mockReset();
});

describe("ConfirmForm", () => {
  it("starts with a single Confirm booking button and no message", () => {
    setup();
    expect(
      screen.getByRole("button", { name: "Confirm booking" }),
    ).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(document.querySelector('input[name="proposal_token"]')).toHaveValue(
      TOKEN,
    );
  });

  it("sends the token only when the user presses the button", async () => {
    confirmBooking.mockResolvedValue({ kind: "idle" });
    setup();
    expect(confirmBooking).not.toHaveBeenCalled();

    await submit();

    expect(confirmBooking).toHaveBeenCalledTimes(1);
    const [previous, formData] = confirmBooking.mock.calls[0] as [
      BookingActionState,
      FormData,
    ];
    expect(previous).toEqual({ kind: "idle" });
    expect(formData.get("proposal_token")).toBe(TOKEN);
  });

  it("shows a busy, disabled button while the booking is being confirmed", async () => {
    let finish: (state: BookingActionState) => void = () => {};
    confirmBooking.mockReturnValue(
      new Promise<BookingActionState>((resolve) => {
        finish = resolve;
      }),
    );
    setup();

    await submit();

    const button = screen.getByRole("button", { name: "Confirming…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Confirming your booking.",
    );

    await act(async () => finish({ kind: "conflict" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("ignores a double click: the second click lands on a disabled button", async () => {
    let finish: (state: BookingActionState) => void = () => {};
    confirmBooking.mockReturnValue(
      new Promise<BookingActionState>((resolve) => {
        finish = resolve;
      }),
    );
    setup();

    const button = screen.getByRole("button", { name: "Confirm booking" });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button); // a fast second click, before the first one has resolved
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirming…" }));
    });

    expect(confirmBooking).toHaveBeenCalledTimes(1);
    await act(async () => finish({ kind: "conflict" }));
  });

  it("is fully operable from the keyboard with a natural tab order", async () => {
    confirmBooking.mockResolvedValue({ kind: "stale" });
    const { container } = setup();

    // Native controls only: nothing needs a custom key handler, and nothing forces tab order.
    const submit = screen.getByRole("button", { name: "Confirm booking" });
    expect(submit.tagName).toBe("BUTTON");
    expect(submit).toHaveAttribute("type", "submit");
    expect(
      container.querySelector("[tabindex]:not([tabindex='-1'])"),
    ).toBeNull();

    submit.focus();
    expect(submit).toHaveFocus();
    // Enter or Space on a focused submit button submits its form (the browser's default).
    await act(async () => {
      fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    });

    // Focus moves to the alert (programmatically focusable only), whose link is then the
    // next tab stop. There is no positive tabindex anywhere.
    const alert = screen.getByRole("alert");
    expect(alert).toHaveFocus();
    expect(alert).toHaveAttribute("tabindex", "-1");
    const link = screen.getByRole("link", { name: "Review again" });
    expect(link.tagName).toBe("A");
    expect(
      container.querySelector("[tabindex]:not([tabindex='-1'])"),
    ).toBeNull();
  });

  it("explains a conflict and offers other times, with no way to resubmit", async () => {
    confirmBooking.mockResolvedValue({ kind: "conflict" });
    setup();
    await submit();

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("That time was just taken");
    expect(alert).toHaveTextContent("Nothing was booked");
    expect(alert).toHaveFocus();
    expect(
      screen.getByRole("link", { name: "Choose another time" }),
    ).toHaveAttribute("href", OPEN_TIMES);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([
    ["stale", "The service details changed since you reviewed this booking"],
    ["expired", "This review expired"],
    ["invalid", "This review could not be verified"],
  ] as const)(
    "%s: says nothing was booked and links to review again, with no retry",
    async (kind, text) => {
      confirmBooking.mockResolvedValue({ kind });
      setup();
      await submit();

      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(text);
      expect(alert).toHaveTextContent("Nothing was booked");
      expect(alert).toHaveFocus();
      expect(
        screen.getByRole("link", { name: "Review again" }),
      ).toHaveAttribute("href", REVIEW);
      // Resubmitting the same token could never succeed, so there is no button at all.
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    },
  );

  it("explains a time that is no longer offered and offers other times, with no retry", async () => {
    confirmBooking.mockResolvedValue({ kind: "not_offered" });
    setup();
    await submit();

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("That time is no longer offered");
    expect(alert).toHaveTextContent("Nothing was booked");
    expect(alert).toHaveFocus();
    expect(
      screen.getByRole("link", { name: "Choose another time" }),
    ).toHaveAttribute("href", OPEN_TIMES);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("treats an unreachable service as an unknown outcome and allows a safe retry", async () => {
    confirmBooking.mockResolvedValue({ kind: "unavailable" });
    setup();
    await submit();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "We can't tell whether the booking was saved",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("never books twice");

    confirmBooking.mockResolvedValue({ kind: "idle" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });

    expect(confirmBooking).toHaveBeenCalledTimes(2);
    const retry = confirmBooking.mock.calls[1] as [
      BookingActionState,
      FormData,
    ];
    expect(retry[1].get("proposal_token")).toBe(TOKEN); // the very same token
  });

  it("offers a retry after a generic error", async () => {
    confirmBooking.mockResolvedValue({ kind: "error" });
    setup();
    await submit();
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it.each([
    "idle",
    "conflict",
    "stale",
    "expired",
    "invalid",
    "not_offered",
    "unavailable",
    "error",
  ] as const)("has no accessibility violations (%s)", async (kind) => {
    confirmBooking.mockResolvedValue({ kind });
    const { container } = setup();
    if (kind !== "idle") await submit();
    await expectNoA11yViolations(container);
  });
});
