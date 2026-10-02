import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { availability, business, services } from "@/test/fixtures";

import Home from "./page";

const { getBusinessOverview, getAvailability } = vi.hoisted(() => ({
  getBusinessOverview: vi.fn(),
  getAvailability: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({ getBusinessOverview, getAvailability }));

describe("/", () => {
  it("keeps the heading breakable when the API cannot be reached", async () => {
    getBusinessOverview.mockResolvedValue({ kind: "unavailable" });
    const props = {
      params: Promise.resolve({}),
      searchParams: Promise.resolve({}),
    } as PageProps<"/">;
    render(await Home(props));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The schedule service isn't responding",
    );
    // At a 320 px viewport with 200% text the display heading is wider than the screen, so
    // without an allowed break the page scrolls sideways (found in the real-browser review).
    expect(
      screen.getByRole("heading", { name: "Quillwheel Cycle Works" }),
    ).toHaveClass("[overflow-wrap:anywhere]");
  });
});

describe("/ : the assistant is the way in", () => {
  const search = (params: Record<string, string>) =>
    ({
      params: Promise.resolve({}),
      searchParams: Promise.resolve(params),
    }) as PageProps<"/">;

  beforeEach(() => {
    getBusinessOverview.mockResolvedValue({
      kind: "ok",
      data: { business, services },
    });
    getAvailability.mockResolvedValue({ kind: "ok", data: availability });
  });

  it("shows no telephone number and no manual-form wording", async () => {
    const { container } = render(await Home(search({})));
    expect(container.textContent).not.toContain(business.phone);
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
    expect(container.textContent).not.toMatch(/form instead/i);
    expect(screen.getByText(business.address)).toBeInTheDocument();
  });

  it("sends every booking entry point to /assistant and none to /book", async () => {
    const { container } = render(
      await Home(search({ service: "flat-repair", date: "2026-10-01" })),
    );
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs.filter((href) => href?.startsWith("/book"))).toEqual([]);
    expect(hrefs).toContain("/assistant");
    expect(hrefs).toContain("/assistant?service=flat-repair");
    expect(hrefs).toContain("/assistant?service=standard-tune-up");
    expect(container.innerHTML).not.toContain("start=");
  });
});
