import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Pending, TurnOutcome } from "@/app/assistant/state";
import { expectNoA11yViolations } from "@/test/axe";
import { agentTurn, proposal, reviewTurn } from "@/test/fixtures";
import { installMedia, type FakeMedia } from "@/test/voice-fakes";

import { ChatPanel } from "./ChatPanel";

const { sendTurn, uuid } = vi.hoisted(() => ({
  sendTurn: vi.fn(),
  uuid: { calls: 0 },
}));
vi.mock("@/app/assistant/actions", () => ({ sendTurn }));
vi.mock("@/app/book/actions", () => ({ confirmBooking: vi.fn() }));
vi.mock("@/lib/uuid", () => ({
  newUuid: () => {
    uuid.calls += 1;
    return `00000000-0000-4000-8000-${String(uuid.calls).padStart(12, "0")}`;
  },
}));

const TOKEN = proposal.proposal_token;

/** The API as it behaves while healthy: it echoes the submission's ids back. */
function answer(
  overrides: (p: Pending) => Partial<ReturnType<typeof agentTurn>> = () => ({}),
) {
  return async (p: Pending): Promise<TurnOutcome> => ({
    kind: "ok",
    turn: agentTurn(p.turnIndex, {
      conversation_id: p.conversationId,
      client_turn_id: p.clientTurnId,
      reply: { source: "assistant", text: `Answer to: ${p.message}` },
      ...overrides(p),
    }),
  });
}

const box = () => screen.getByLabelText("Your message") as HTMLTextAreaElement;

function type(text: string) {
  fireEvent.change(box(), { target: { value: text } });
}

async function send(text: string) {
  type(text);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  });
}

function submissions(): Pending[] {
  return sendTurn.mock.calls.map((call) => call[0] as Pending);
}

beforeEach(() => {
  sendTurn.mockReset();
  sendTurn.mockImplementation(answer());
  uuid.calls = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ChatPanel: the empty conversation", () => {
  it("invites the visitor to act, labels the composer and does not take focus", () => {
    render(<ChatPanel />);

    expect(
      screen.getByRole("heading", { name: "Conversation" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/The assistant is an AI/)).toBeInTheDocument();
    expect(box()).toHaveAttribute("maxlength", "500");
    expect(screen.getByText("0 of 500 characters")).toBeInTheDocument();
    expect(screen.getByText(/Press Enter to send/)).toBeInTheDocument();
    expect(document.body).toHaveFocus();
    expect(sendTurn).not.toHaveBeenCalled();
    expect(
      screen.getByRole("complementary", { name: "Execution timeline" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
  });

  it("fills the composer from a suggestion without sending it", () => {
    render(<ChatPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "What does the shop do?" }),
    );
    expect(box()).toHaveValue("What does the shop do?");
    expect(box()).toHaveFocus();
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("counts characters", () => {
    render(<ChatPanel />);
    type("hello");
    expect(screen.getByText("5 of 500 characters")).toBeInTheDocument();
  });
});

describe("ChatPanel: sending", () => {
  it("makes the conversation id and a turn id on the first send and sends turn 1", async () => {
    render(<ChatPanel />);
    await send("  What do you do?  ");

    expect(submissions()).toEqual([
      {
        conversationId: "00000000-0000-4000-8000-000000000001",
        clientTurnId: "00000000-0000-4000-8000-000000000002",
        turnIndex: 1,
        message: "What do you do?", // the normalized message
      },
    ]);
  });

  it("shows the answer, clears the composer, announces it and moves focus to the reply", async () => {
    render(<ChatPanel />);
    await send("What do you do?");

    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Assistant (AI)")).toBeInTheDocument();
    expect(screen.getByText("Answer to: What do you do?")).toBeInTheDocument();
    expect(box()).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent(
      "The assistant replied.",
    );
    expect(document.getElementById("current-reply-1")).toHaveFocus();
    // The timeline lists the turn.
    expect(screen.getByRole("heading", { name: "Turn 1" })).toBeInTheDocument();
  });

  it("keeps the conversation id, makes a new turn id and advances the turn index", async () => {
    render(<ChatPanel />);
    await send("one");
    await send("two");
    await send("three");

    const [first, second, third] = submissions();
    expect(
      new Set([first, second, third].map((s) => s.conversationId)).size,
    ).toBe(1);
    expect(
      new Set([first, second, third].map((s) => s.clientTurnId)).size,
    ).toBe(3);
    expect([first.turnIndex, second.turnIndex, third.turnIndex]).toEqual([
      1, 2, 3,
    ]);
    expect(uuid.calls).toBe(1 + 3); // one conversation id, one id per submission
  });

  it("sends on Enter, adds a line on Shift+Enter and ignores Enter while composing text", async () => {
    render(<ChatPanel />);
    type("hello");

    await act(async () => {
      fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    });
    await act(async () => {
      fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    });
    expect(sendTurn).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(box(), { key: "Enter" });
    });
    expect(sendTurn).toHaveBeenCalledTimes(1);
  });

  it("allows a newline typed with Shift+Enter inside the message", async () => {
    render(<ChatPanel />);
    await send("line one\nline two");
    expect(submissions()[0].message).toBe("line one\nline two");
  });

  it("blocks a duplicate submission while one is in flight", async () => {
    let finish: (outcome: TurnOutcome) => void = () => {};
    sendTurn.mockReturnValue(
      new Promise<TurnOutcome>((resolve) => {
        finish = resolve;
      }),
    );
    render(<ChatPanel />);
    type("hello");

    await act(async () => {
      fireEvent.keyDown(box(), { key: "Enter" });
      fireEvent.keyDown(box(), { key: "Enter" });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    });

    expect(sendTurn).toHaveBeenCalledTimes(1);
    const button = screen.getByRole("button", { name: "Sending…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(box()).toHaveAttribute("readonly");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Sending your message.",
    );
    expect(screen.getByText("You (not answered yet)")).toBeInTheDocument();

    await act(async () => finish(await answer()(submissions()[0])));
    expect(
      screen.queryByText("You (not answered yet)"),
    ).not.toBeInTheDocument();
  });

  it("refuses an empty or oversized message in the browser, without calling the action", async () => {
    render(<ChatPanel />);
    type("   ");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Write a message of 1 to 500 characters.");
    expect(alert).toHaveFocus();
    expect(sendTurn).not.toHaveBeenCalled();
  });
});

describe("ChatPanel: uncertain outcomes and pauses", () => {
  it("keeps the exact submission and resends it unchanged, with no new id", async () => {
    sendTurn.mockResolvedValueOnce({
      kind: "retry",
      reason: "unknown",
      retryAfterS: null,
    });
    render(<ChatPanel />);
    await send("hello there");

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "We couldn't tell whether the assistant answered",
    );
    expect(alert).toHaveTextContent("won't repeat an answer it already gave");
    expect(alert).not.toHaveTextContent(/exactly once/i);
    expect(alert).toHaveFocus();
    expect(screen.getByText("You (not answered yet)")).toBeInTheDocument();
    expect(screen.getByText("hello there")).toBeInTheDocument();
    expect(screen.queryByLabelText("Your message")).not.toBeInTheDocument();
    const idsAfterFirst = uuid.calls;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });

    const [first, retried] = submissions();
    expect(retried).toEqual(first); // the same four values, byte for byte
    expect(uuid.calls).toBe(idsAfterFirst); // no id was made for the retry
    expect(screen.getByText("Answer to: hello there")).toBeInTheDocument();
  });

  it("does not advance the turn index until a turn is accepted", async () => {
    sendTurn
      .mockResolvedValueOnce({
        kind: "retry",
        reason: "unknown",
        retryAfterS: null,
      })
      .mockResolvedValueOnce({
        kind: "retry",
        reason: "unknown",
        retryAfterS: null,
      });
    render(<ChatPanel />);
    await send("hello");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(screen.getByRole("alert")).toBeInTheDocument(); // still uncertain

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    await send("next");

    expect(submissions().map((s) => s.turnIndex)).toEqual([1, 1, 1, 2]);
    expect(
      new Set(
        submissions()
          .slice(0, 3)
          .map((s) => s.clientTurnId),
      ).size,
    ).toBe(1);
    expect(submissions()[3].clientTurnId).not.toBe(
      submissions()[0].clientTurnId,
    );
  });

  it("treats a failure of the action itself as an unknown outcome and retries the same message", async () => {
    sendTurn.mockRejectedValueOnce(new Error("network"));
    render(<ChatPanel />);
    await send("hello");
    expect(screen.getByRole("alert")).toHaveTextContent("couldn't tell");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(submissions()[1]).toEqual(submissions()[0]);
  });

  it.each([
    ["in_progress", "The assistant is still working on it", 2],
    ["busy", "The assistant is busy", 5],
  ] as const)(
    "%s: waits for the Retry-After time, then resends the same submission",
    async (reason, title, seconds) => {
      vi.useFakeTimers();
      sendTurn.mockResolvedValueOnce({
        kind: "retry",
        reason,
        retryAfterS: seconds,
      });
      render(<ChatPanel />);
      await send("hello");

      expect(screen.getByRole("alert")).toHaveTextContent(title);
      const button = screen.getByRole("button", {
        name: "Try again in a moment",
      });
      expect(button).toBeDisabled();

      await act(async () => {
        vi.advanceTimersByTime(seconds * 1000 - 1);
      });
      expect(
        screen.getByRole("button", { name: "Try again in a moment" }),
      ).toBeDisabled();

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      const ready = screen.getByRole("button", { name: "Try again" });
      expect(ready).toBeEnabled();

      await act(async () => {
        fireEvent.click(ready);
      });
      expect(submissions()[1]).toEqual(submissions()[0]);
      expect(uuid.calls).toBe(2);
    },
  );
});

describe("ChatPanel: ways out", () => {
  it("never traps the visitor in the retry state", async () => {
    sendTurn.mockResolvedValue({
      kind: "retry",
      reason: "unknown",
      retryAfterS: null,
    });
    render(<ChatPanel />);
    await send("hello");

    const alert = screen.getByRole("alert");
    expect(
      within(alert).getByRole("button", { name: "Try again" }),
    ).toBeEnabled();
    expect(
      within(alert).getByRole("link", { name: "Book with the form instead" }),
    ).toHaveAttribute("href", "/#availability");

    await act(async () => {
      fireEvent.click(
        within(alert).getByRole("button", { name: "Start a new conversation" }),
      );
    });
    // The unanswered message is kept in the earlier, read-only conversation.
    const earlier = screen
      .getByText(/Earlier conversation, read-only/)
      .closest("details") as HTMLElement;
    expect(within(earlier).getByText("hello")).toBeInTheDocument();
    expect(box()).toBeInTheDocument();
  });

  it("says the conversation is full instead of sending turn 31, and keeps the draft", async () => {
    render(<ChatPanel />);
    for (let n = 1; n <= 30; n += 1) await send(`message ${n}`);
    expect(sendTurn).toHaveBeenCalledTimes(30);

    type("one more");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    });

    expect(sendTurn).toHaveBeenCalledTimes(30); // turn 31 was never sent
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This conversation is full",
    );
    expect(screen.queryByLabelText("Your message")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Start a new conversation" }),
      );
    });
    expect(box()).toHaveValue("one more"); // nothing the visitor wrote is lost
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    });
    expect((submissions().at(-1) as Pending).turnIndex).toBe(1);
  }, 30000);

  it("clears the invalid-message flag as soon as the text is edited", async () => {
    render(<ChatPanel />);
    type("   ");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    });
    expect(box()).toHaveAttribute("aria-invalid", "true");
    type("something");
    expect(box()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("ChatPanel: the assistant is not available", () => {
  it("explains it and links to the booking form", async () => {
    sendTurn.mockResolvedValueOnce({ kind: "agent_unavailable" });
    render(<ChatPanel />);
    await send("hello");

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The assistant isn't switched on");
    expect(alert).toHaveFocus();
    expect(
      within(alert).getByRole("link", { name: "Book with the form instead" }),
    ).toHaveAttribute("href", "/#availability");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(box()).toHaveValue("hello"); // nothing the visitor wrote is lost
  });

  it("shows a message the API refused and lets it be edited", async () => {
    sendTurn.mockResolvedValueOnce({ kind: "rejected" });
    render(<ChatPanel />);
    await send("hello");

    expect(screen.getByRole("alert")).toHaveTextContent(
      "That message wasn't accepted",
    );
    expect(box()).toHaveValue("hello");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    });
    expect(sendTurn).toHaveBeenCalledTimes(2);
    expect(submissions()[1].clientTurnId).not.toBe(
      submissions()[0].clientTurnId,
    );
  });
});

describe("ChatPanel: a conversation that cannot continue", () => {
  it.each([
    ["not_found", "This conversation can't continue"],
    ["expired", "This conversation expired"],
    ["out_of_order", "This conversation is out of step"],
    ["key_reused", "That message can't be sent again"],
    ["limit", "This conversation is full"],
  ] as const)(
    "%s: keeps the transcript read-only and offers a new conversation",
    async (reason, title) => {
      render(<ChatPanel />);
      await send("first question");
      sendTurn.mockResolvedValueOnce({ kind: "ended", reason });
      await send("second question");

      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(title);
      expect(alert).toHaveTextContent(
        "Your messages stay on this page, read-only.",
      );
      expect(alert).not.toHaveTextContent(/exactly once/i);
      expect(alert).toHaveFocus();

      // Everything said so far is still there, including the message that was not answered.
      expect(screen.getByText("first question")).toBeInTheDocument();
      expect(screen.getByText("Answer to: first question")).toBeInTheDocument();
      expect(screen.getByText("second question")).toBeInTheDocument();
      expect(screen.getByText("You (not answered yet)")).toBeInTheDocument();
      // And nothing can be sent in it.
      expect(screen.queryByLabelText("Your message")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Send message" }),
      ).not.toBeInTheDocument();
    },
  );

  it("starts a new conversation while the old transcript stays read-only", async () => {
    render(<ChatPanel />);
    await send("first question");
    sendTurn.mockResolvedValueOnce({ kind: "ended", reason: "not_found" });
    await send("second question");
    const oldConversation = submissions()[0].conversationId;

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Start a new conversation" }),
      );
    });

    const earlier = screen.getByText(
      /Earlier conversation, read-only \(1 turn\)/,
    );
    const details = earlier.closest("details") as HTMLElement;
    expect(within(details).getByText("first question")).toBeInTheDocument();
    expect(within(details).getByText("second question")).toBeInTheDocument();
    expect(within(details).queryByRole("button")).not.toBeInTheDocument();
    expect(box()).toHaveValue("");

    await send("fresh start");
    const fresh = submissions().at(-1) as Pending;
    expect(fresh.conversationId).not.toBe(oldConversation);
    expect(fresh.turnIndex).toBe(1);
    expect(screen.getByText("Answer to: fresh start")).toBeInTheDocument();
  });

  it("can also be restarted by choice, which keeps the old transcript", async () => {
    render(<ChatPanel />);
    await send("hello");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Start a new conversation" }),
      );
    });
    expect(
      screen.getByText(/Earlier conversation, read-only/),
    ).toBeInTheDocument();
  });
});

describe("ChatPanel: degraded answers and reviews", () => {
  it("shows a degraded turn as a System message", async () => {
    sendTurn.mockResolvedValueOnce({
      kind: "ok",
      turn: agentTurn(1, {
        outcome: "degraded",
        reply: {
          source: "system",
          text: "The assistant took too long to answer.",
        },
      }),
    });
    render(<ChatPanel />);
    await send("hello");

    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.queryByText("Assistant (AI)")).not.toBeInTheDocument();
    expect(
      screen.getByText("The assistant took too long to answer."),
    ).toBeInTheDocument();
  });

  it("renders a prepared review with the existing ConfirmForm and the token only in its hidden field", async () => {
    sendTurn.mockResolvedValueOnce({ kind: "ok", turn: reviewTurn(1) });
    const { container } = render(<ChatPanel />);
    await send("the first one");

    expect(
      screen.getByText(
        "Review prepared by the schedule service — nothing is booked until you confirm.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm booking" }),
    ).toBeEnabled();
    const hidden = container.querySelectorAll('input[name="proposal_token"]');
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toHaveValue(TOKEN);
    expect(container.textContent).not.toContain(TOKEN);
    expect(container.innerHTML.split(TOKEN).length - 1).toBe(1);
    // The timeline names the review but not the token.
    expect(
      screen.getByText(/The schedule service prepared a booking review/),
    ).toBeInTheDocument();
  });

  it("keeps a valid review visible when the same turn degraded", async () => {
    sendTurn.mockResolvedValueOnce({
      kind: "ok",
      turn: reviewTurn(1, {
        outcome: "degraded",
        reply: {
          source: "system",
          text: "I prepared the booking review below, but couldn't finish my reply. Nothing is booked until you press Confirm booking.",
        },
      }),
    });
    render(<ChatPanel />);
    await send("the first one");

    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText(/couldn't finish my reply/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm booking" }),
    ).toBeInTheDocument();
  });

  it("offers a confirm button only for the newest review", async () => {
    sendTurn
      .mockResolvedValueOnce({ kind: "ok", turn: reviewTurn(1) })
      .mockResolvedValueOnce({ kind: "ok", turn: reviewTurn(2) });
    const { container } = render(<ChatPanel />);
    await send("one");
    await send("two");

    expect(
      screen.getAllByRole("button", { name: "Confirm booking" }),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('input[name="proposal_token"]'),
    ).toHaveLength(1);
  });

  it("removes every confirm button from a conversation that ended", async () => {
    sendTurn.mockResolvedValueOnce({ kind: "ok", turn: reviewTurn(1) });
    const { container } = render(<ChatPanel />);
    await send("one");
    sendTurn.mockResolvedValueOnce({ kind: "ended", reason: "expired" });
    await send("two");

    expect(
      screen.queryByRole("button", { name: "Confirm booking" }),
    ).not.toBeInTheDocument();
    expect(container.querySelector('input[name="proposal_token"]')).toBeNull();
    expect(container.innerHTML).not.toContain(TOKEN);
  });
});

describe("ChatPanel: safety and storage", () => {
  it("renders hostile model text as plain text", async () => {
    const hostile =
      '<img src=x onerror="alert(1)"> [click](http://evil.example) http://evil.example **bold**';
    sendTurn.mockResolvedValueOnce({
      kind: "ok",
      turn: agentTurn(1, { reply: { source: "assistant", text: hostile } }),
    });
    const { container } = render(<ChatPanel />);
    await send("hello");

    expect(container.querySelector("img, strong, script")).toBeNull();
    expect(container.querySelector('a[href*="evil"]')).toBeNull();
    expect(container.textContent).toContain("[click](http://evil.example)");
  });

  it("never stores anything in the browser", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const cookie = vi.spyOn(document, "cookie", "set");
    render(<ChatPanel />);
    await send("hello");
    await send("again");

    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("does not show ids from the API anywhere on the page", async () => {
    sendTurn.mockResolvedValueOnce({ kind: "ok", turn: reviewTurn(1) });
    const { container } = render(<ChatPanel />);
    await send("hello");

    const text = container.textContent ?? "";
    expect(text).not.toContain(submissions()[0].conversationId);
    expect(text).not.toContain(submissions()[0].clientTurnId);
    expect(text).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });
});

describe("ChatPanel: the timeline column", () => {
  it("opens beside the conversation on large screens and collapses on small ones", () => {
    const listeners: Array<() => void> = [];
    const query = {
      matches: true,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => query),
    );
    const { container } = render(<ChatPanel />);
    const details = container.querySelector("details") as HTMLDetailsElement;

    expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 1024px)");
    expect(details.open).toBe(true);

    query.matches = false;
    act(() => listeners.forEach((fn) => fn()));
    expect(details.open).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("ChatPanel: accessibility", () => {
  it("has no violations when empty", async () => {
    const { container } = render(<ChatPanel />);
    await expectNoA11yViolations(container);
  });

  it("has no violations with a conversation and a review", async () => {
    sendTurn
      .mockResolvedValueOnce({ kind: "ok", turn: agentTurn(1) })
      .mockResolvedValueOnce({ kind: "ok", turn: reviewTurn(2) });
    const { container } = render(<ChatPanel />);
    await send("one");
    await send("two");
    await expectNoA11yViolations(container);
  });

  it.each([
    [
      "an uncertain outcome",
      { kind: "retry", reason: "unknown", retryAfterS: null },
    ],
    ["a pause", { kind: "retry", reason: "busy", retryAfterS: 5 }],
    ["an unavailable assistant", { kind: "agent_unavailable" }],
    ["an ended conversation", { kind: "ended", reason: "expired" }],
    ["a refused message", { kind: "rejected" }],
  ] as const)("has no violations for %s", async (_name, outcome) => {
    sendTurn.mockResolvedValueOnce(outcome);
    const { container } = render(<ChatPanel />);
    await send("hello");
    await expectNoA11yViolations(container);
  });
});

describe("ChatPanel: voice input", () => {
  const fetchMock = vi.fn();
  let media: FakeMedia;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  function serve(options: { available?: boolean; text?: string } = {}) {
    const {
      available = true,
      text = "Do you have time for a flat repair on Tuesday?",
    } = options;
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("probe=1") ? json({ available }) : json({ text }),
      ),
    );
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("fetch", fetchMock);
    media = installMedia();
  });

  afterEach(() => {
    media.uninstall();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  async function dictate() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Speak" }));
    });
    await screen.findByRole("button", { name: "Stop" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
  }

  it("puts the transcript in the message box, focuses it, and does not send it", async () => {
    serve();
    render(<ChatPanel />);

    await dictate();

    await vi.waitFor(() =>
      expect(box().value).toBe(
        "Do you have time for a flat repair on Tuesday?",
      ),
    );
    expect(box()).toHaveFocus();
    expect(box().selectionStart).toBe(box().value.length); // cursor at the end, ready to edit
    expect(sendTurn).not.toHaveBeenCalled(); // never auto-sent
    expect(screen.getByText("46 of 500 characters")).toBeInTheDocument();
    expect(screen.queryByText(/Sending/)).toBeNull();
  });

  it("lets the visitor edit the transcript, and only Send sends the edited text", async () => {
    serve();
    render(<ChatPanel />);
    await dictate();
    await vi.waitFor(() => expect(box().value).not.toBe(""));

    type("Do you have time for a tune-up on Friday?");
    expect(sendTurn).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    });

    expect(submissions().map((s) => s.message)).toEqual([
      "Do you have time for a tune-up on Friday?",
    ]);
  });

  it("adds the transcript after what was already typed", async () => {
    serve({ text: "on Tuesday" });
    render(<ChatPanel />);
    type("Do you have time for a flat repair");

    await dictate();

    await vi.waitFor(() =>
      expect(box().value).toBe("Do you have time for a flat repair on Tuesday"),
    );
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("never lets the box go over 500 characters", async () => {
    serve({ text: "y".repeat(400) });
    render(<ChatPanel />);
    type("x".repeat(300));

    await dictate();

    await vi.waitFor(() => expect(box().value.length).toBe(500));
    expect(screen.getByText("500 of 500 characters")).toBeInTheDocument();
  });

  it("keeps typing and sending available when voice fails", async () => {
    serve({ available: false });
    render(<ChatPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Speak" }));
    });
    expect(
      await screen.findByText("Voice input isn't switched on"),
    ).toBeInTheDocument();
    expect(media.getUserMedia).not.toHaveBeenCalled();

    await send("How much is a flat repair?");

    expect(submissions().map((s) => s.message)).toEqual([
      "How much is a flat repair?",
    ]);
    expect(
      await screen.findByText(/Answer to: How much is a flat repair/),
    ).toBeInTheDocument();
  });

  it("keeps the typed message when a recording fails", async () => {
    serve({ available: false });
    render(<ChatPanel />);
    type("I was typing this");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Speak" }));
    });
    await screen.findByRole("alert");
    expect(box().value).toBe("I was typing this");
  });

  it("cannot start a recording while a message is being sent", async () => {
    serve();
    let release: (o: TurnOutcome) => void = () => undefined;
    sendTurn.mockImplementation(
      () => new Promise<TurnOutcome>((resolve) => (release = resolve)),
    );
    render(<ChatPanel />);
    await send("Hello");
    expect(screen.getByRole("button", { name: "Speak" })).toBeDisabled();
    await act(async () => {
      release({ kind: "agent_unavailable" });
    });
  });

  it("tells the visitor when the transcript had to be shortened, and the notice goes away on edit", async () => {
    serve({ text: "y".repeat(400) });
    render(<ChatPanel />);
    type("x".repeat(300));

    await dictate();

    expect(
      await screen.findByText(
        /The transcript was shortened to fit 500 characters/,
      ),
    ).toBeInTheDocument();
    expect(box().value.startsWith("x".repeat(300))).toBe(true); // what was typed is kept
    type(box().value.slice(0, 100));
    expect(screen.queryByText(/was shortened/)).toBeNull();
  });

  it("does not say it was shortened when everything fit", async () => {
    serve({ text: "short words" });
    render(<ChatPanel />);
    await dictate();
    await vi.waitFor(() => expect(box().value).toBe("short words"));
    expect(screen.queryByText(/was shortened/)).toBeNull();
  });

  it("sending ends a transcription still in flight, so its text cannot arrive after the box is cleared", async () => {
    let answer: (response: Response) => void = () => undefined;
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("probe=1")
        ? Promise.resolve(json({ available: true }))
        : new Promise<Response>((resolve) => {
            answer = resolve; // ignores the abort: a late answer must still be dropped
          }),
    );
    render(<ChatPanel />);
    await dictate();
    await screen.findByRole("button", { name: "Cancel transcription" });

    type("Typed meanwhile");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    });
    await act(async () => {
      answer(json({ text: "late transcript" }));
    });

    expect(submissions().map((s) => s.message)).toEqual(["Typed meanwhile"]);
    expect(box().value).toBe(""); // the late transcript did not come back into the box
    expect(screen.queryByText(/Cancel transcription/)).toBeNull();
  });

  it("has no axe violations with voice input present", async () => {
    serve();
    const { container } = render(<ChatPanel />);
    await expectNoA11yViolations(container);
  });
});
