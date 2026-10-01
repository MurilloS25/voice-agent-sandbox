import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ApiResult,
  AppointmentProposal,
  BusinessOverview,
} from "@/lib/api/client";
import { business, proposal, services } from "@/test/fixtures";

import BookPage from "./page";

const { createProposal, getBusinessOverview } = vi.hoisted(() => ({
  createProposal: vi.fn(),
  getBusinessOverview: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({ createProposal, getBusinessOverview }));
vi.mock("./actions", () => ({ confirmBooking: vi.fn() }));

const overview: ApiResult<BusinessOverview> = {
  kind: "ok",
  data: { business, services },
};

async function renderPage(search: Record<string, string>) {
  const props = {
    params: Promise.resolve({}),
    searchParams: Promise.resolve(search),
  } as PageProps<"/book">;
  render(await BookPage(props));
}

beforeEach(() => {
  createProposal.mockReset();
  getBusinessOverview.mockReset();
  getBusinessOverview.mockResolvedValue(overview);
});

describe("/book", () => {
  // Real-browser review: at a 320 px viewport with 200% text the `text-5xl` heading is wider
  // than the screen, so every heading state must allow a break inside a long word.
  it.each([
    ["no selection", {}, null, "Choose a time first"],
    [
      "a rejected selection",
      { service: "flat-repair", start: "nope" },
      { kind: "error", status: 422, code: "validation_error", message: "x" },
      "We couldn't prepare that booking",
    ],
    [
      "a valid selection",
      { service: "flat-repair", start: proposal.start },
      { kind: "ok", data: proposal },
      "Review your booking",
    ],
  ])(
    "keeps the heading breakable: %s",
    async (_state, search, result, heading) => {
      if (result) createProposal.mockResolvedValue(result);
      await renderPage(search);
      expect(screen.getByRole("heading", { name: heading })).toHaveClass(
        "[overflow-wrap:anywhere]",
      );
    },
  );

  it("asks for a selection when none is given, without calling the API", async () => {
    await renderPage({});
    expect(
      screen.getByRole("heading", { name: "Choose a time first" }),
    ).toBeInTheDocument();
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("shows the review and the confirm button for a valid selection", async () => {
    createProposal.mockResolvedValue({
      kind: "ok",
      data: proposal,
    } satisfies ApiResult<AppointmentProposal>);

    await renderPage({ service: "flat-repair", start: proposal.start });

    expect(createProposal).toHaveBeenCalledWith("flat-repair", proposal.start);
    // The proposal carries the timezone, so the happy path makes a single API call.
    expect(getBusinessOverview).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Review your booking" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Demo Amber Heron")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm booking" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("complementary")).toHaveTextContent(
      "Fictional demo",
    );
    expect(
      screen.getByRole("link", { name: "Choose a different time" }),
    ).toHaveAttribute(
      "href",
      "/?service=flat-repair&date=2026-10-01#availability",
    );
  });

  it("does not crash on a start value that is not a date", async () => {
    createProposal.mockResolvedValue({
      kind: "error",
      status: 422,
      code: "validation_error",
      message: "Choose an open time from the list.",
    });

    await renderPage({ service: "Flat Repair", start: "nope" });

    expect(
      screen.getByRole("heading", {
        name: "We couldn't prepare that booking",
      }),
    ).toBeInTheDocument();
    // With no valid date the link falls back to the unfiltered availability section.
    expect(
      screen.getByRole("link", { name: "Back to open times" }),
    ).toHaveAttribute("href", "/#availability");
  });

  it("explains a slot that was taken before the review", async () => {
    createProposal.mockResolvedValue({
      kind: "error",
      status: 409,
      code: "slot_unavailable",
      message: "ignored",
    });
    await renderPage({ service: "flat-repair", start: proposal.start });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "That time was just taken. Choose another time.",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to open times" }),
    ).toHaveAttribute(
      "href",
      "/?service=flat-repair&date=2026-10-01#availability",
    );
    // On the failure path only, the timezone comes from the business overview.
    expect(getBusinessOverview).toHaveBeenCalledTimes(1);
  });

  it("shows the unavailable notice when the API cannot be reached", async () => {
    createProposal.mockResolvedValue({ kind: "unavailable" });
    getBusinessOverview.mockResolvedValue({ kind: "unavailable" });
    await renderPage({ service: "flat-repair", start: proposal.start });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The schedule service isn't responding",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
