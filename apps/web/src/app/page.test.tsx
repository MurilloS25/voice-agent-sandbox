import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import Home from "./page";

const { getBusinessOverview } = vi.hoisted(() => ({
  getBusinessOverview: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({
  getBusinessOverview,
  getAvailability: vi.fn(),
}));

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
