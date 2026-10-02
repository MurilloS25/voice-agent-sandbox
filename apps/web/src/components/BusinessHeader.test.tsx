import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { business } from "@/test/fixtures";

import { BusinessHeader } from "./BusinessHeader";

describe("BusinessHeader", () => {
  it("links to the assistant", () => {
    render(<BusinessHeader business={business} />);
    expect(
      screen.getByRole("link", { name: "Ask the assistant" }),
    ).toHaveAttribute("href", "/assistant");
  });

  it("keeps the address but shows no telephone number", () => {
    const { container } = render(<BusinessHeader business={business} />);
    expect(screen.getByText(business.address)).toBeInTheDocument();
    expect(container.textContent).not.toContain(business.phone);
    expect(container.textContent).not.toMatch(/\+?\d[\d\s-]{6,}\d/);
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
  });
});
