import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Pending, TurnOutcome } from "@/app/assistant/state";
import { resetSpeechOutput } from "@/lib/voice/use-speech-output";
import { agentTurn, reviewTurn } from "@/test/fixtures";
import { fakeVoice, installSpeech } from "@/test/speech-fakes";
import { installMedia, type FakeMedia } from "@/test/voice-fakes";

import { QUICK_ACTIONS, WELCOME_TEXT } from "./AssistantWelcome";
import { ChatPanel } from "./ChatPanel";

const { sendTurn, confirmBooking, uuid } = vi.hoisted(() => ({
  sendTurn: vi.fn(),
  confirmBooking: vi.fn(),
  uuid: { calls: 0 },
}));
vi.mock("@/app/assistant/actions", () => ({ sendTurn }));
vi.mock("@/app/book/actions", () => ({ confirmBooking }));
vi.mock("@/lib/uuid", () => ({
  newUuid: () => {
    uuid.calls += 1;
    return `00000000-0000-4000-8000-${String(uuid.calls).padStart(12, "0")}`;
  },
}));

async function answer(p: Pending): Promise<TurnOutcome> {
  return {
    kind: "ok",
    turn: agentTurn(p.turnIndex, {
      conversation_id: p.conversationId,
      client_turn_id: p.clientTurnId,
      reply: { source: "assistant", text: `Answer to: ${p.message}` },
    }),
  };
}

const box = () => screen.getByLabelText("Your message") as HTMLTextAreaElement;
const type = (text: string) =>
  fireEvent.change(box(), { target: { value: text } });
const submissions = () => sendTurn.mock.calls.map((call) => call[0] as Pending);

async function press(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

beforeEach(() => {
  sendTurn.mockReset();
  sendTurn.mockImplementation(answer);
  confirmBooking.mockReset();
  uuid.calls = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the welcome", () => {
  it("is the assistant's first message, says it is an AI, and has the agreed words", () => {
    render(<ChatPanel />);
    const welcome = screen.getByLabelText("Welcome from the assistant");
    expect(within(welcome).getByText("Assistant (AI)")).toBeInTheDocument();
    expect(within(welcome).getByText(WELCOME_TEXT)).toBeInTheDocument();
    expect(WELCOME_TEXT).toBe(
      "Hi! I’m Quillwheel’s workshop assistant. I can explain our services, check available times, and prepare a booking for your confirmation. How can I help?",
    );
  });

  it("costs nothing: no call, no conversation id, no announcement", () => {
    render(<ChatPanel />);
    expect(sendTurn).not.toHaveBeenCalled();
    expect(uuid.calls).toBe(0);
    expect(screen.getByRole("status", { name: "" })).toBeEmptyDOMElement();
  });

  it("is never sent: the first send is turn 1 and carries only the visitor's words", async () => {
    render(<ChatPanel />);
    type("hello");
    await press("Send message");
    expect(submissions()).toHaveLength(1);
    expect(submissions()[0].turnIndex).toBe(1);
    expect(submissions()[0].message).toBe("hello");
    expect(JSON.stringify(submissions())).not.toContain("workshop assistant");
    // It stays on the page as the first message.
    expect(screen.getByText(WELCOME_TEXT)).toBeInTheDocument();
  });

  it("is never read aloud and has no Listen button, even with read-aloud on", () => {
    const synth = installSpeech([fakeVoice({ name: "L", localService: true })]);
    resetSpeechOutput();
    render(<ChatPanel />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Read replies aloud" }),
    );
    expect(synth.spoken).toHaveLength(0);
    expect(
      within(screen.getByLabelText("Welcome from the assistant")).queryByRole(
        "button",
        { name: /Listen/ },
      ),
    ).toBeNull();
    resetSpeechOutput();
    vi.unstubAllGlobals();
  });

  it("only fills the message box from a quick start; the visitor sends it", async () => {
    render(<ChatPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Find an afternoon appointment" }),
    );
    expect(box()).toHaveValue("Can you find me an afternoon appointment?");
    expect(sendTurn).not.toHaveBeenCalled();
    await press("Send message");
    expect(submissions().map((s) => s.message)).toEqual([
      "Can you find me an afternoon appointment?",
    ]);
  });

  it("hides the quick starts once the conversation begins but keeps the greeting", async () => {
    render(<ChatPanel />);
    type("hello");
    await press("Send message");
    expect(
      screen.queryByRole("button", { name: "See available services" }),
    ).toBeNull();
    expect(screen.getByText(WELCOME_TEXT)).toBeInTheDocument();
  });
});

describe("a draft from a link", () => {
  it("shows it in the box, editable, and sends nothing", () => {
    render(<ChatPanel initialDraft="Do you have time for Flat repair?" />);
    expect(box()).toHaveValue("Do you have time for Flat repair?");
    expect(box()).not.toHaveAttribute("readonly");
    expect(sendTurn).not.toHaveBeenCalled();
    expect(uuid.calls).toBe(0);
    type("Something else");
    expect(box()).toHaveValue("Something else");
  });

  it("prepares the draft when the chat is already open and the box is empty, and focuses it", () => {
    const { rerender } = render(<ChatPanel />);
    expect(box()).not.toHaveFocus();
    rerender(<ChatPanel initialDraft="Do you have time for Flat repair?" />);
    expect(box()).toHaveValue("Do you have time for Flat repair?");
    expect(box()).toHaveFocus();
    expect(sendTurn).not.toHaveBeenCalled();
    expect(uuid.calls).toBe(0);
  });

  it("treats a box with only spaces as empty for a context that arrives later", () => {
    const { rerender } = render(<ChatPanel />);
    type("   ");
    rerender(<ChatPanel initialDraft="Later context" />);
    expect(box()).toHaveValue("Later context");
  });

  it("keeps text the visitor wrote when a context arrives: no change, no concatenation, no send", () => {
    const { rerender } = render(<ChatPanel />);
    type("Typed by the visitor");
    rerender(<ChatPanel initialDraft="Do you have time for Flat repair?" />);
    expect(box()).toHaveValue("Typed by the visitor");
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("does not bring an old context back when the box is cleared afterwards", () => {
    const { rerender } = render(<ChatPanel />);
    type("Typed by the visitor");
    rerender(<ChatPanel initialDraft="Ignored context" />); // ignored
    type("");
    expect(box()).toHaveValue("");
    rerender(<ChatPanel initialDraft="Ignored context" />); // same context, same page
    expect(box()).toHaveValue("");

    rerender(<ChatPanel initialDraft="Applied later" />); // a new one, box empty: applies
    expect(box()).toHaveValue("Applied later");
    type("");
    rerender(<ChatPanel initialDraft="Applied later" />);
    expect(box()).toHaveValue("");
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("applies a different valid context later, only while the box is empty", () => {
    const { rerender } = render(<ChatPanel initialDraft="First context" />);
    expect(box()).toHaveValue("First context");
    type("");
    rerender(<ChatPanel initialDraft="Second context" />);
    expect(box()).toHaveValue("Second context");
    rerender(<ChatPanel initialDraft="Third context" />); // box has text now
    expect(box()).toHaveValue("Second context");
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("produces no draft when the context is invalid (an empty draft)", () => {
    const { rerender } = render(<ChatPanel initialDraft="First context" />);
    type("");
    rerender(<ChatPanel initialDraft="" />);
    expect(box()).toHaveValue("");
  });

  it("keeps the conversation when a context arrives", async () => {
    const { rerender } = render(<ChatPanel />);
    type("hello");
    await press("Send message");
    expect(await screen.findByText("Answer to: hello")).toBeInTheDocument();
    rerender(<ChatPanel initialDraft="Do you have time for Flat repair?" />);
    expect(screen.getByText("Answer to: hello")).toBeInTheDocument();
    expect(box()).toHaveValue("Do you have time for Flat repair?");
    expect(submissions()).toHaveLength(1); // nothing else was sent
  });

  it("never replaces a draft that was typed before: quick starts wait", () => {
    render(<ChatPanel initialDraft="Do you have time for Flat repair?" />);
    for (const action of QUICK_ACTIONS) {
      expect(screen.getByRole("button", { name: action.label })).toBeDisabled();
    }
    expect(
      screen.getByText(/Quick starts fill an empty message box/),
    ).toBeInTheDocument();
    expect(box()).toHaveValue("Do you have time for Flat repair?");
  });
});

describe("quick starts and text the visitor wrote", () => {
  it("are disabled, with a visible note, while the box has text, and the text is kept", () => {
    render(<ChatPanel />);
    type("My own question");
    for (const action of QUICK_ACTIONS) {
      const button = screen.getByRole("button", { name: action.label });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(box()).toHaveValue("My own question");
    expect(
      screen.getByText(/Quick starts fill an empty message box/),
    ).toBeInTheDocument();
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("work again once the box is cleared, and then fill it without sending", () => {
    render(<ChatPanel />);
    type("My own question");
    type("");
    const button = screen.getByRole("button", { name: QUICK_ACTIONS[0].label });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(box()).toHaveValue(QUICK_ACTIONS[0].draft);
    expect(box()).toHaveFocus();
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("treat a box with only spaces as empty", () => {
    render(<ChatPanel />);
    type("   ");
    expect(
      screen.getByRole("button", { name: QUICK_ACTIONS[1].label }),
    ).toBeEnabled();
  });
});

describe("Review again goes back to the assistant", () => {
  it("links an expired review to /assistant with the service and the local day", async () => {
    confirmBooking.mockResolvedValueOnce({ kind: "expired" });
    sendTurn.mockResolvedValueOnce({ kind: "ok", turn: reviewTurn(1) });
    render(<ChatPanel />);
    type("the first one");
    await press("Send message");
    await press("Confirm booking");
    const link = await screen.findByRole("link", { name: "Review again" });
    expect(link).toHaveAttribute(
      "href",
      "/assistant?service=flat-repair&date=2026-10-01",
    );
    expect(document.body.innerHTML).not.toContain("/book");
  });
});

describe("the assistant is not switched on", () => {
  it("Try again sends the kept message once more; there is no manual form", async () => {
    sendTurn.mockResolvedValueOnce({ kind: "agent_unavailable" });
    render(<ChatPanel />);
    type("hello");
    await press("Send message");
    expect(
      screen.getByRole("link", { name: "Back to workshop" }),
    ).toHaveAttribute("href", "/");
    expect(screen.queryByText(/form instead/i)).toBeNull();

    await press("Try again");
    expect(submissions().map((s) => s.message)).toEqual(["hello", "hello"]);
    expect(await screen.findByText("Answer to: hello")).toBeInTheDocument();
  });
});

describe("a transcript waits for the visitor", () => {
  const fetchMock = vi.fn();
  let media: FakeMedia;
  let transcripts: string[];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("fetch", fetchMock);
    media = installMedia();
    transcripts = ["first take", "second take"];
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            String(url).includes("probe=1")
              ? { available: true }
              : { text: transcripts.shift() ?? "later take" },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
  });

  afterEach(() => {
    media.uninstall();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  async function record(name: "Speak" | "Record again") {
    await press(name);
    await screen.findByRole("button", { name: "Stop" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await press("Stop");
  }

  it("offers Send transcript and Record again, and sends nothing by itself", async () => {
    render(<ChatPanel />);
    await record("Speak");
    await vi.waitFor(() => expect(box().value).toBe("first take"));

    expect(
      screen.getByRole("button", { name: "Send transcript" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Record again" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("Record again replaces a transcript that was left as it was", async () => {
    render(<ChatPanel />);
    await record("Speak");
    await vi.waitFor(() => expect(box().value).toBe("first take"));
    await record("Record again");
    await vi.waitFor(() => expect(box().value).toBe("second take"));
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("Record again keeps what the visitor typed before the transcript", async () => {
    render(<ChatPanel />);
    type("Hello,");
    await record("Speak");
    await vi.waitFor(() => expect(box().value).toBe("Hello, first take"));
    await record("Record again");
    await vi.waitFor(() => expect(box().value).toBe("Hello, second take"));
  });

  it("Send transcript sends the checked text once; the button is Send message again after", async () => {
    render(<ChatPanel />);
    await record("Speak");
    await vi.waitFor(() => expect(box().value).toBe("first take"));
    await press("Send transcript");
    expect(submissions().map((s) => s.message)).toEqual(["first take"]);
    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Speak" })).toBeInTheDocument();
  });

  it("still sends from the keyboard with Enter", async () => {
    render(<ChatPanel />);
    await record("Speak");
    await vi.waitFor(() => expect(box().value).toBe("first take"));
    await act(async () => {
      fireEvent.keyDown(box(), { key: "Enter" });
    });
    expect(submissions().map((s) => s.message)).toEqual(["first take"]);
  });
});

describe("Record again that does not produce a transcript", () => {
  it("keeps the transcript the visitor was checking", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const media = installMedia();
    fetchMock.mockImplementation((url: string) => {
      const probe = String(url).includes("probe=1");
      const body = probe ? { available: true } : { text: "first take" };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    render(<ChatPanel />);
    await press("Speak");
    await screen.findByRole("button", { name: "Stop" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await press("Stop");
    await vi.waitFor(() => expect(box().value).toBe("first take"));

    // The microphone is refused the second time.
    media.getUserMedia.mockRejectedValueOnce(
      new DOMException("no", "NotAllowedError"),
    );
    await press("Record again");
    await screen.findByRole("alert");
    expect(box().value).toBe("first take");
    media.uninstall();
    vi.unstubAllGlobals();
  });
});
