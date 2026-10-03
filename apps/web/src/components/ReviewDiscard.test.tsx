import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Pending } from "@/app/assistant/state";
import type { AgentTurn } from "@/lib/api/client";
import { reviewStatus } from "@/lib/review-state";
import { expectNoA11yViolations } from "@/test/axe";
import { agentTurn, proposal, reviewTurn } from "@/test/fixtures";

import { ChatPanel } from "./ChatPanel";

const { sendTurn, confirmBooking } = vi.hoisted(() => ({
  sendTurn: vi.fn(),
  confirmBooking: vi.fn(),
}));
vi.mock("@/app/assistant/actions", () => ({ sendTurn }));
vi.mock("@/app/book/actions", () => ({ confirmBooking }));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const TOKEN = proposal.proposal_token;
const at = "2026-10-01T12:00:00Z";

type Reason = "declined" | "changed_search" | "replaced";

/** A turn in which the API withdrew the waiting review (and answered in plain text). */
function discardTurn(
  turnIndex: number,
  reason: Reason,
  p?: Pending,
): AgentTurn {
  return agentTurn(turnIndex, {
    ...(p ? { conversation_id: p.conversationId } : {}),
    reply: { source: "assistant", text: "Okay, I dropped that proposal." },
    events: [
      { seq: 1, at, kind: "user_message", actor: "user", text: "never mind" },
      {
        seq: 2,
        at,
        kind: "booking_review_discarded",
        actor: "tool",
        reason,
        service_name: "Flat repair",
        local_date: "2026-10-01",
        local_start: "09:00",
      },
      {
        seq: 3,
        at,
        kind: "assistant_message",
        actor: "assistant",
        text: "Okay, I dropped that proposal.",
      },
    ],
  });
}

const box = () => screen.getByLabelText("Your message") as HTMLTextAreaElement;

async function send(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  });
}

const confirmButtons = () =>
  screen.queryAllByRole("button", { name: "Confirm booking" });

beforeEach(() => {
  sendTurn.mockReset();
  confirmBooking.mockReset();
});

describe("reviewStatus", () => {
  const turn = (response: AgentTurn) => ({ response });
  it("is the latest review, and no earlier one", () => {
    const result = reviewStatus([
      turn(reviewTurn(1)),
      turn(agentTurn(2)),
      turn(reviewTurn(3)),
    ]);
    expect(result.live).toBe(3);
    expect([...result.discarded]).toEqual([1]);
  });

  it.each(["declined", "changed_search", "replaced"] as const)(
    "has no live review after a turn that withdrew it (%s)",
    (reason) => {
      const result = reviewStatus([
        turn(reviewTurn(1)),
        turn(discardTurn(2, reason)),
      ]);
      expect(result.live).toBeNull();
      expect([...result.discarded]).toEqual([1]);
    },
  );

  it("keeps the review through turns that do not withdraw it", () => {
    const result = reviewStatus([
      turn(reviewTurn(1)),
      turn(agentTurn(2)),
      turn(agentTurn(3)),
    ]);
    expect(result.live).toBe(1);
    expect(result.discarded.size).toBe(0);
  });

  it("makes a review after a withdrawal live again, and only that one", () => {
    const result = reviewStatus([
      turn(reviewTurn(1)),
      turn(discardTurn(2, "declined")),
      turn(reviewTurn(3)),
    ]);
    expect(result.live).toBe(3);
    expect([...result.discarded]).toEqual([1]);
  });

  it("a withdrawal and a new review in the same turn leave the new one live", () => {
    const replacing = reviewTurn(2, {
      events: [
        ...discardTurn(2, "replaced").events.slice(1, 2),
        ...reviewTurn(2).events,
      ],
    });
    const result = reviewStatus([turn(reviewTurn(1)), turn(replacing)]);
    expect(result.live).toBe(2);
    expect([...result.discarded]).toEqual([1]);
  });

  it("does nothing for a withdrawal when no review was live", () => {
    expect(reviewStatus([turn(discardTurn(1, "declined"))])).toEqual({
      live: null,
      discarded: new Set(),
    });
  });
});

describe("ChatPanel: a rejected booking review stops being actionable", () => {
  it("removes Confirm booking when the visitor declined the review", async () => {
    sendTurn
      .mockResolvedValueOnce({ kind: "ok", turn: reviewTurn(1) })
      .mockImplementationOnce(async (p: Pending) => ({
        kind: "ok",
        turn: discardTurn(2, "declined", p),
      }));
    const { container } = render(<ChatPanel assumeReady initialMode="text" />);
    await send("the first one");
    expect(confirmButtons()).toHaveLength(1);

    await send("never mind, I do not want that");

    expect(confirmButtons()).toHaveLength(0); // no button can confirm it
    expect(container.querySelector('input[name="proposal_token"]')).toBeNull();
    expect(container.innerHTML).not.toContain(TOKEN); // and the token is not in the page
    expect(confirmBooking).not.toHaveBeenCalled();
    // The history keeps a clearly marked, non-actionable card.
    const card = screen.getByRole("region", {
      name: "Booking review for reply 1 (no longer active)",
    });
    expect(
      within(card).getByText(/No longer active — this review was discarded/),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(/books and cancels nothing/i),
    ).toBeInTheDocument();
    expect(within(card).queryByRole("button")).toBeNull();
    expect(card.textContent).not.toMatch(/cancel(l)?ed/i); // it never claims a cancellation
  });

  it("removes Confirm booking after a wrong date and a new search", async () => {
    sendTurn
      .mockResolvedValueOnce({ kind: "ok", turn: reviewTurn(1) })
      .mockImplementationOnce(async (p: Pending) => ({
        kind: "ok",
        turn: discardTurn(2, "changed_search", p),
      }));
    render(<ChatPanel assumeReady initialMode="text" />);
    await send("the first one");
    await send("wrong date, try Thursday");
    expect(confirmButtons()).toHaveLength(0);
    expect(
      screen.getByRole("region", {
        name: /Booking review for reply 1 \(no longer active\)/,
      }),
    ).toBeInTheDocument();
  });

  it("keeps Confirm booking through a question that does not replace the review", async () => {
    sendTurn
      .mockResolvedValueOnce({ kind: "ok", turn: reviewTurn(1) })
      .mockImplementationOnce(async (p: Pending) => ({
        kind: "ok",
        turn: agentTurn(2, { conversation_id: p.conversationId }),
      }));
    render(<ChatPanel assumeReady initialMode="text" />);
    await send("the first one");
    await send("when are you open?");
    expect(confirmButtons()).toHaveLength(1);
    expect(
      screen.getByRole("region", { name: "Booking review for reply 1" }),
    ).toBeInTheDocument();
  });

  it("a new review replaces the discarded one, and confirming it uses the unchanged form", async () => {
    sendTurn
      .mockResolvedValueOnce({ kind: "ok", turn: reviewTurn(1) })
      .mockImplementationOnce(async (p: Pending) => ({
        kind: "ok",
        turn: discardTurn(2, "declined", p),
      }))
      .mockImplementationOnce(async (p: Pending) => ({
        kind: "ok",
        turn: reviewTurn(3, { conversation_id: p.conversationId }),
      }));
    const { container } = render(<ChatPanel assumeReady initialMode="text" />);
    await send("one");
    await send("never mind");
    await send("the second time");

    expect(confirmButtons()).toHaveLength(1);
    expect(
      container.querySelectorAll('input[name="proposal_token"]'),
    ).toHaveLength(1);
    expect(
      screen.getByRole("region", { name: "Booking review for reply 3" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", {
        name: "Booking review for reply 1 (no longer active)",
      }),
    ).toBeInTheDocument();
    // The one live form is the existing ConfirmForm (a form whose submit is the Server Action).
    const form = confirmButtons()[0].closest("form");
    expect(form).not.toBeNull();
    expect(
      within(form as HTMLElement).getByText(/Confirm booking/),
    ).toBeInTheDocument();
  });

  it("explains a discarded confirmation without claiming a booking or a cancellation", async () => {
    sendTurn.mockResolvedValueOnce({ kind: "ok", turn: reviewTurn(1) });
    confirmBooking.mockResolvedValueOnce({ kind: "discarded" });
    render(<ChatPanel assumeReady initialMode="text" />);
    await send("the first one");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm booking" }));
    });
    expect(
      await screen.findByText("This review is no longer active"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing was booked/)).toBeInTheDocument();
  });

  it("lists the withdrawal in the activity panel in words, without a token", async () => {
    sendTurn
      .mockResolvedValueOnce({ kind: "ok", turn: reviewTurn(1) })
      .mockImplementationOnce(async (p: Pending) => ({
        kind: "ok",
        turn: discardTurn(2, "changed_search", p),
      }));
    const { container } = render(<ChatPanel assumeReady initialMode="text" />);
    await send("one");
    await send("two");
    fireEvent.click(
      screen.getByRole("button", { name: "How this answer was made" }),
    );
    const panel = screen.getByRole("complementary", {
      name: "How this answer was made",
    });
    expect(
      within(panel).getByText("A booking review is no longer active"),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(/another service or day/),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(/books and cancels nothing/i),
    ).toBeInTheDocument();
    expect(panel.textContent).not.toContain(TOKEN);
    expect(container.textContent).not.toContain(TOKEN);
  });

  it("has no accessibility violations with a no-longer-active card", async () => {
    sendTurn
      .mockResolvedValueOnce({ kind: "ok", turn: reviewTurn(1) })
      .mockImplementationOnce(async (p: Pending) => ({
        kind: "ok",
        turn: discardTurn(2, "declined", p),
      }));
    const { container } = render(<ChatPanel assumeReady initialMode="text" />);
    await send("one");
    await send("two");
    await expectNoA11yViolations(container);
  });

  it("the card is reachable by keyboard only through its real link, and holds no Confirm control", async () => {
    sendTurn
      .mockResolvedValueOnce({ kind: "ok", turn: reviewTurn(1) })
      .mockImplementationOnce(async (p: Pending) => ({
        kind: "ok",
        turn: discardTurn(2, "declined", p),
      }));
    render(<ChatPanel assumeReady initialMode="text" />);
    await send("one");
    await send("two");
    const card = screen.getByRole("region", {
      name: /no longer active/,
    });
    const links = within(card).queryAllByRole("link");
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
    expect(within(card).queryAllByRole("textbox")).toHaveLength(0);
    const focusable = links;
    expect(focusable.map((el) => el.tagName)).toEqual(["A"]);
    expect(focusable[0]).toHaveAccessibleName("Review this time again");
    // It wraps at 320 px: no fixed widths, only the card's own max-width and padding.
    expect(card.className).toMatch(/max-w-2xl/);
    expect(card.className).not.toMatch(/\bw-\[\d+px\]|min-w-\[/);
  });
});
