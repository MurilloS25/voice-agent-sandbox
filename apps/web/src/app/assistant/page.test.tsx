import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { business, services } from "@/test/fixtures";
import { expectNoA11yViolations } from "@/test/axe";
import { installMedia, type FakeMedia } from "@/test/voice-fakes";

import AssistantPage from "./page";

const { getBusinessOverview } = vi.hoisted(() => ({
  getBusinessOverview: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({ getBusinessOverview }));
vi.mock("./actions", () => ({ sendTurn: vi.fn() }));
vi.mock("@/app/book/actions", () => ({ confirmBooking: vi.fn() }));

const toText = () =>
  fireEvent.click(screen.getByRole("button", { name: "Text" }));

async function renderPage(search: Record<string, string> = {}) {
  const props = {
    params: Promise.resolve({}),
    searchParams: Promise.resolve(search),
  } as PageProps<"/assistant">;
  return render(await AssistantPage(props));
}

let media: FakeMedia;

afterEach(() => {
  media.uninstall();
});

beforeEach(() => {
  media = installMedia(); // a browser that can record: Voice is what the visitor meets first
  getBusinessOverview.mockReset();
  getBusinessOverview.mockResolvedValue({
    kind: "ok",
    data: { business, services },
  });
});

describe("/assistant", () => {
  it("is a branded, fictional-demo page with a way back and no manual booking path", async () => {
    await renderPage();

    expect(screen.getByLabelText("Demo notice")).toBeInTheDocument();
    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Workshop assistant",
    });
    // Real-browser rule from the booking pages: a long word must be allowed to break.
    expect(heading.className).toContain("[overflow-wrap:anywhere]");
    expect(screen.getByText("Quillwheel Cycle Works")).toBeInTheDocument();
    expect(screen.getByText("AI assistant")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to workshop" }),
    ).toHaveAttribute("href", "/");
    // Voice is the first thing the visitor meets; Text is one press away.
    expect(
      screen.getByRole("button", { name: "Start voice assistant" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Voice" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    toText();
    expect(screen.getByLabelText("Your message")).toBeInTheDocument();
    expect(screen.queryByText(/form instead/i)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("/#availability");
    expect(getBusinessOverview).not.toHaveBeenCalled();
  });

  it("uses one main landmark and one h1", async () => {
    const { container } = await renderPage();
    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
  });

  it("turns a service and a date into an editable draft and sends nothing", async () => {
    await renderPage({ service: "flat-repair", date: "2026-10-01" });
    // In Voice the prepared question waits, unsent, with a way to review it in Text.
    expect(
      screen.getByText(/A message is waiting in Text/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review it in Text" }));
    expect(screen.getByLabelText("Your message")).toHaveValue(
      "Do you have time for Flat repair on Thursday, October 1, 2026?",
    );
    expect(screen.getByLabelText("Your message")).not.toHaveAttribute(
      "readonly",
    );
  });

  it("ignores a time, an unknown service and a malformed date", async () => {
    await renderPage({
      service: "no-such-service",
      date: "2026-02-30",
      start: "2026-10-01T13:00:00Z",
    });
    expect(screen.queryByText(/A message is waiting in Text/)).toBeNull();
    toText();
    expect(screen.getByLabelText("Your message")).toHaveValue("");
  });

  it("keeps working, without a draft for the service, when the schedule service is down", async () => {
    getBusinessOverview.mockResolvedValue({ kind: "unavailable" });
    await renderPage({ service: "flat-repair" });
    toText();
    expect(screen.getByLabelText("Your message")).toHaveValue("");
  });

  it("has no accessibility violations", async () => {
    const { container } = await renderPage({ service: "flat-repair" });
    await expectNoA11yViolations(container);
  });
});
