import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { expectNoA11yViolations } from "@/test/axe";
import { agentTurn, proposal, reviewTurn } from "@/test/fixtures";

import { Transcript } from "./Transcript";

vi.mock("@/app/book/actions", () => ({ confirmBooking: vi.fn() }));

const TOKEN = proposal.proposal_token;
const REVIEW_SENTENCE =
  "Review prepared by the schedule service — nothing is booked until you confirm.";

describe("Transcript", () => {
  it("is an ordered list that labels who wrote what", () => {
    const { container } = render(
      <Transcript
        idPrefix="t"
        turns={[
          { message: "Question 1", response: agentTurn(1) },
          {
            message: "Question 2",
            response: agentTurn(2, {
              outcome: "degraded",
              reply: { source: "system", text: "That took too long." },
            }),
          },
        ]}
      />,
    );

    expect(container.querySelector("ol")).not.toBeNull();
    expect(screen.getAllByText("You")).toHaveLength(2);
    expect(screen.getByText("Assistant (AI)")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText("That took too long.")).toBeInTheDocument();
  });

  it("shows a message that has not been answered yet", () => {
    render(<Transcript idPrefix="t" turns={[]} unsent="Still waiting" />);
    expect(screen.getByText("You (not answered yet)")).toBeInTheDocument();
    expect(screen.getByText("Still waiting")).toBeInTheDocument();
  });

  it("renders model and user text as plain text: no HTML, no Markdown, no links", () => {
    const text =
      '<img src=x onerror="alert(1)"> **bold** [click](http://evil.example) http://evil.example <a href="http://evil.example">x</a>';
    const { container } = render(
      <Transcript
        idPrefix="t"
        turns={[
          {
            message: text,
            response: agentTurn(1, { reply: { source: "assistant", text } }),
          },
        ]}
      />,
    );

    expect(container.querySelector("img, a, strong, b, em, script")).toBeNull();
    expect(container.textContent).toContain("**bold**");
    expect(container.textContent).toContain("[click](http://evil.example)");
    expect(container.innerHTML).not.toContain("<img");
  });

  it("renders a valid review with the fixed sentence and the existing ConfirmForm", () => {
    const { container } = render(
      <Transcript
        idPrefix="t"
        turns={[{ message: "The first one", response: reviewTurn(1) }]}
        liveReviewTurn={1}
      />,
    );

    expect(screen.getByText(REVIEW_SENTENCE)).toBeInTheDocument();
    expect(screen.getByText("Flat repair")).toBeInTheDocument(); // BookingReview
    expect(
      screen.getByRole("button", { name: "Confirm booking" }),
    ).toBeEnabled();

    // The token exists only as the hidden form value: never as visible text or an attribute
    // elsewhere.
    const hidden = container.querySelectorAll('input[name="proposal_token"]');
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toHaveValue(TOKEN);
    expect(hidden[0]).toHaveAttribute("type", "hidden");
    expect(container.textContent).not.toContain(TOKEN);
    expect(container.innerHTML.split(TOKEN).length - 1).toBe(1);
    // The model never appears to have confirmed anything.
    expect(container.textContent).not.toMatch(
      /(?<!nothing )(?<!not )\b(has been|is now|was) (booked|confirmed)/i,
    );
  });

  it("still renders a valid review in a degraded response, with the system explanation", () => {
    render(
      <Transcript
        idPrefix="t"
        turns={[
          {
            message: "first",
            response: reviewTurn(1, {
              outcome: "degraded",
              reply: {
                source: "system",
                text: "I prepared the booking review below, but couldn't finish my reply. Nothing is booked until you press Confirm booking.",
              },
            }),
          },
        ]}
        liveReviewTurn={1}
      />,
    );
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText(/couldn't finish my reply/)).toBeInTheDocument();
    expect(screen.getByText(REVIEW_SENTENCE)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm booking" }),
    ).toBeInTheDocument();
  });

  it("offers a confirm button only for the live review; older and read-only ones link back", () => {
    const { container, rerender } = render(
      <Transcript
        idPrefix="t"
        turns={[
          { message: "a", response: reviewTurn(1) },
          { message: "b", response: reviewTurn(2) },
        ]}
        liveReviewTurn={2}
      />,
    );
    expect(
      screen.getAllByRole("button", { name: "Confirm booking" }),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('input[name="proposal_token"]'),
    ).toHaveLength(1);
    expect(
      screen.getByRole("link", { name: "Review this time again" }),
    ).toHaveAttribute("href", "/assistant?service=flat-repair&date=2026-10-01");

    rerender(
      <Transcript
        idPrefix="t"
        readOnly
        turns={[{ message: "a", response: reviewTurn(1) }]}
        liveReviewTurn={1}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container.querySelector('input[name="proposal_token"]')).toBeNull();
    expect(container.innerHTML).not.toContain(TOKEN);
  });

  it("labels each booking review by its reply so landmarks stay unique", () => {
    render(
      <Transcript
        idPrefix="t"
        turns={[
          { message: "a", response: reviewTurn(1) },
          { message: "b", response: reviewTurn(2) },
        ]}
        liveReviewTurn={2}
      />,
    );
    expect(
      screen.getByRole("region", { name: "Booking review for reply 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Booking review for reply 2" }),
    ).toBeInTheDocument();
  });

  it("moves focus to the response of the turn it is told to", () => {
    const turns = [
      { message: "a", response: agentTurn(1) },
      { message: "b", response: agentTurn(2) },
    ];
    const { rerender } = render(<Transcript idPrefix="t" turns={turns} />);
    expect(document.body).toHaveFocus(); // nothing is focused on first render

    rerender(<Transcript idPrefix="t" turns={turns} focusTurn={2} />);
    const reply = document.getElementById("t-reply-2") as HTMLElement;
    expect(reply).toHaveFocus();
    expect(within(reply).getByText("Assistant (AI)")).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <Transcript
        idPrefix="t"
        turns={[
          { message: "a", response: agentTurn(1) },
          { message: "b", response: reviewTurn(2) },
        ]}
        unsent="pending"
        liveReviewTurn={2}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
