import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { expectNoA11yViolations } from "@/test/axe";

import AssistantPage from "./page";

vi.mock("./actions", () => ({ sendTurn: vi.fn() }));
vi.mock("@/app/book/actions", () => ({ confirmBooking: vi.fn() }));

describe("/assistant", () => {
  it("says it is a fictional demo and offers the form instead", () => {
    render(<AssistantPage />);

    expect(screen.getByLabelText("Demo notice")).toBeInTheDocument();
    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Ask the workshop",
    });
    // Real-browser rule from the booking pages: a long word must be allowed to break.
    expect(heading.className).toContain("[overflow-wrap:anywhere]");
    expect(
      screen.getAllByRole("link", { name: "Book with the form instead" })[0],
    ).toHaveAttribute("href", "/#availability");
    expect(
      screen.getByRole("link", { name: "Back to the workshop" }),
    ).toHaveAttribute("href", "/");
    expect(screen.getByLabelText("Your message")).toBeInTheDocument();
  });

  it("uses one main landmark and one h1", () => {
    const { container } = render(<AssistantPage />);
    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<AssistantPage />);
    await expectNoA11yViolations(container);
  });
});
