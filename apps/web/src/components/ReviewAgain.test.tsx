import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Pending, TurnOutcome } from "@/app/assistant/state";
import { draftFor } from "@/lib/assistant-link";
import { expectNoA11yViolations } from "@/test/axe";
import { reviewTurn } from "@/test/fixtures";

import { ChatPanel } from "./ChatPanel";

const { sendTurn, confirmBooking } = vi.hoisted(() => ({
  sendTurn: vi.fn(),
  confirmBooking: vi.fn(),
}));
vi.mock("@/app/assistant/actions", () => ({ sendTurn }));
vi.mock("@/app/book/actions", () => ({ confirmBooking }));
// A plain anchor: the test only needs the click, not the router.
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

const SAME_CONTEXT = draftFor({
  serviceName: "Flat repair",
  date: "2026-10-01",
});

async function answer(p: Pending): Promise<TurnOutcome> {
  return {
    kind: "ok",
    turn: { ...reviewTurn(p.turnIndex), conversation_id: p.conversationId },
  };
}

const box = () => screen.getByLabelText("Your message") as HTMLTextAreaElement;
const type = (text: string) =>
  fireEvent.change(box(), { target: { value: text } });
const again = () =>
  screen.getByRole("link", { name: "Review this time again" });

async function press(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

/** A chat with two review cards: the first is no longer active and offers "Review this time again". */
async function twoReviews(initialDraft = "") {
  const view = render(
    <ChatPanel assumeReady initialMode="text" initialDraft={initialDraft} />,
  );
  for (const text of ["the first one", "the first one again"]) {
    type(text);
    await press("Send message");
    await screen.findAllByRole("region", { name: /Booking review for reply/ });
  }
  return view;
}

beforeEach(() => {
  sendTurn.mockReset();
  sendTurn.mockImplementation(answer);
  confirmBooking.mockReset();
});

describe("Review again with the same context as the page already has", () => {
  it("prepares the draft and focuses the box when it is empty", async () => {
    await twoReviews(SAME_CONTEXT); // the page was opened with this very context
    expect(box()).toHaveValue("");
    fireEvent.click(again());
    expect(box()).toHaveValue(SAME_CONTEXT);
    expect(box()).toHaveFocus();
  });

  it("works on every click: clearing the box and clicking again prepares it again", async () => {
    await twoReviews(SAME_CONTEXT);
    fireEvent.click(again());
    expect(box()).toHaveValue(SAME_CONTEXT);
    type("");
    fireEvent.click(again());
    expect(box()).toHaveValue(SAME_CONTEXT);
    type("   ");
    fireEvent.click(again());
    expect(box()).toHaveValue(SAME_CONTEXT);
  });

  it("keeps text the visitor wrote: no overwrite, no concatenation", async () => {
    await twoReviews(SAME_CONTEXT);
    type("my own words");
    fireEvent.click(again());
    expect(box()).toHaveValue("my own words");
  });

  it("sends nothing and keeps the conversation and its cards", async () => {
    await twoReviews(SAME_CONTEXT);
    const sent = sendTurn.mock.calls.length;
    fireEvent.click(again());
    fireEvent.click(again());
    expect(sendTurn).toHaveBeenCalledTimes(sent);
    expect(
      screen.getAllByRole("region", { name: /Booking review for reply/ }),
    ).toHaveLength(2);
    expect(screen.getByText("the first one again")).toBeInTheDocument();
    expect(confirmBooking).not.toHaveBeenCalled();
  });

  it("does not bring the context back by itself when the box is only cleared", async () => {
    await twoReviews(SAME_CONTEXT);
    fireEvent.click(again());
    type("");
    expect(box()).toHaveValue("");
    await act(async () => {
      await Promise.resolve();
    });
    expect(box()).toHaveValue("");
  });

  it("ignores a click with a modifier key (opening it elsewhere is not a request here)", async () => {
    await twoReviews(SAME_CONTEXT);
    fireEvent.click(again(), { ctrlKey: true });
    fireEvent.click(again(), { shiftKey: true });
    expect(box()).toHaveValue("");
  });

  it("also works from the Review again link of a review that expired", async () => {
    confirmBooking.mockResolvedValueOnce({ kind: "expired" });
    render(
      <ChatPanel assumeReady initialMode="text" initialDraft={SAME_CONTEXT} />,
    );
    type("the first one");
    await press("Send message");
    await press("Confirm booking");
    const link = await screen.findByRole("link", { name: "Review again" });
    expect(box()).toHaveValue("");
    fireEvent.click(link);
    expect(box()).toHaveValue(SAME_CONTEXT);
    expect(box()).toHaveFocus();
    expect(sendTurn).toHaveBeenCalledTimes(1);
  });
});

describe("contexts that arrive through the address still work as before", () => {
  it("uses the initial context, and a new one later, only into an empty box", () => {
    const { rerender } = render(
      <ChatPanel assumeReady initialMode="text" initialDraft="First context" />,
    );
    expect(box()).toHaveValue("First context");
    type("");
    rerender(
      <ChatPanel
        assumeReady
        initialMode="text"
        initialDraft="Second context"
      />,
    );
    expect(box()).toHaveValue("Second context");
    type("typed");
    rerender(
      <ChatPanel assumeReady initialMode="text" initialDraft="Third context" />,
    );
    expect(box()).toHaveValue("typed");
    type("");
    rerender(
      <ChatPanel assumeReady initialMode="text" initialDraft="Third context" />,
    );
    expect(box()).toHaveValue(""); // the same address context is not applied twice
    expect(sendTurn).not.toHaveBeenCalled();
  });
});

describe("the Review again link", () => {
  it("is a real link with a clear name, to the assistant with service and day only", async () => {
    await twoReviews();
    expect(again()).toHaveAttribute(
      "href",
      "/assistant?service=flat-repair&date=2026-10-01",
    );
    const card = screen.getByRole("region", {
      name: "Booking review for reply 1",
    });
    expect(within(card).getByRole("link")).toBe(again());
  });

  it("leaves the page without accessibility violations after a click", async () => {
    const { container } = await twoReviews(SAME_CONTEXT);
    fireEvent.click(again());
    await expectNoA11yViolations(container);
  });
});
