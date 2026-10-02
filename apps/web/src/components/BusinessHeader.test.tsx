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
});
