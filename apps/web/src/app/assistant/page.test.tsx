import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { business, services } from "@/test/fixtures";
import { expectNoA11yViolations } from "@/test/axe";

import AssistantPage from "./page";

const { getBusinessOverview } = vi.hoisted(() => ({
  getBusinessOverview: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({ getBusinessOverview }));
vi.mock("./actions", () => ({ sendTurn: vi.fn() }));
vi.mock("@/app/book/actions", () => ({ confirmBooking: vi.fn() }));

async function renderPage(search: Record<string, string> = {}) {
  const props = {
    params: Promise.resolve({}),
    searchParams: Promise.resolve(search),
  } as PageProps<"/assistant">;
  return render(await AssistantPage(props));
}

beforeEach(() => {
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
    expect(screen.getByLabelText("Your message")).toHaveValue("");
  });

  it("keeps working, without a draft for the service, when the schedule service is down", async () => {
    getBusinessOverview.mockResolvedValue({ kind: "unavailable" });
    await renderPage({ service: "flat-repair" });
    expect(screen.getByLabelText("Your message")).toHaveValue("");
  });

  it("has no accessibility violations", async () => {
    const { container } = await renderPage({ service: "flat-repair" });
    await expectNoA11yViolations(container);
  });
});
