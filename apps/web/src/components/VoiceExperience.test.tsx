import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Pending, TurnOutcome } from "@/app/assistant/state";
import { PREVIEW_TEXT } from "@/lib/voice/stage";
import { resetSpeechOutput } from "@/lib/voice/use-speech-output";
import { expectNoA11yViolations } from "@/test/axe";
import { agentTurn, proposal, reviewTurn } from "@/test/fixtures";
import { fakeVoice, installSpeech, type FakeSynth } from "@/test/speech-fakes";
import { FakeAudioContext, installAudio } from "@/test/audio-fakes";
import { installMedia, type FakeMedia } from "@/test/voice-fakes";

import { VOICE_READY_TEXT, WELCOME_TEXT } from "./AssistantWelcome";
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

const TOKEN = proposal.proposal_token;
const LOCAL = fakeVoice({ name: "Local voice", localService: true });
const NETWORK = fakeVoice({ name: "Network voice", localService: false });
const fetchMock = vi.fn();

let synth: FakeSynth;
let media: FakeMedia;
let transcripts: string[];

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

const submissions = () => sendTurn.mock.calls.map((call) => call[0] as Pending);
const spoken = () => synth.texts.join(" | ");

async function press(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

const heardBox = () =>
  screen.getByLabelText(
    "What I heard (you can edit it)",
  ) as HTMLTextAreaElement;
const status = () => screen.getAllByRole("status")[0];

/** The next microphone request fails the way a browser reports it. */
function refuseMicrophone(name: string) {
  media.getUserMedia.mockRejectedValueOnce(
    Object.assign(new Error("refused"), { name }),
  );
}

/** The browser reports that the first part of the last utterance really started playing. */
function browserStartsSpeaking() {
  act(() => synth.spoken[synth.spoken.length - 1].onstart?.());
}
function browserFinishesSpeaking() {
  act(() => synth.spoken[synth.spoken.length - 1].onend?.());
}

const SETTINGS_KEY = "quillwheel.voice-settings.v1";

/**
 * Most of these tests drive the manual review ("Review transcript before sending" on); the
 * automatic flow, which is the default, is covered with `review: false`.
 */
function setup(
  props: {
    initialMode?: "voice" | "text";
    voices?: SpeechSynthesisVoice[];
    /** Manual review of the transcript. Default here is on; pass false for the product default. */
    review?: boolean;
  } = {},
) {
  if (props.review !== false && localStorage.getItem(SETTINGS_KEY) === null) {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        voiceName: null,
        rate: 0.95,
        reviewBeforeSending: true,
      }),
    );
  }
  synth = installSpeech(props.voices ?? [LOCAL]);
  resetSpeechOutput(); // the controller reads the browser (and its storage) again
  return render(<ChatPanel assumeReady initialMode={props.initialMode} />);
}

/** Start the session and let the welcome finish, so the stage is Ready. */
async function startSession() {
  await press("Start voice assistant");
  browserStartsSpeaking();
  browserFinishesSpeaking();
}

/** One complete voice turn up to the review: tap, record, stop, transcribe. */
async function recordUntilReview(expected?: string) {
  await press("Tap to speak");
  await screen.findByRole("button", { name: "Stop" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  await press("Stop");
  await vi.waitFor(() => {
    expect(heardBox().value).toBe(expected ?? heardBox().value);
    expect(heardBox().value).not.toBe("");
  });
}

async function speakToTheAssistant(says?: string) {
  await recordUntilReview(says);
  await press("Send what I said");
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  sendTurn.mockReset();
  sendTurn.mockImplementation(answer);
  confirmBooking.mockReset();
  uuid.calls = 0;
  localStorage.clear();
  transcripts = ["first take", "second take", "third take"];
  fetchMock.mockReset();
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
  vi.stubGlobal("fetch", fetchMock);
  media = installMedia();
});

afterEach(() => {
  media.uninstall();
  resetSpeechOutput();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Voice is the first mode", () => {
  it("starts in Voice, with Start as the one main control and no composer", () => {
    setup();
    expect(screen.getByRole("button", { name: "Voice" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Text" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      screen.getByRole("button", { name: "Start voice assistant" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Your message")).toBeNull();
    expect(screen.getByText(WELCOME_TEXT)).toBeInTheDocument();
  });

  it("plays nothing and asks for no microphone before Start", () => {
    setup();
    expect(synth.spoken).toHaveLength(0);
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(sendTurn).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses real, labelled controls for the modes and the secondary panels", () => {
    setup();
    for (const name of [
      "Voice",
      "Text",
      "View transcript",
      "How this answer was made",
      "Voice settings",
    ]) {
      const control = screen.getByRole("button", { name });
      expect(control.tagName).toBe("BUTTON");
      expect(control).toHaveAttribute("type", "button");
    }
  });
});

describe("Start voice assistant", () => {
  it("speaks the local welcome from the click itself, with nothing awaited first", () => {
    setup();
    // No `act`/`await`: whatever runs must have run synchronously inside the click.
    fireEvent.click(
      screen.getByRole("button", { name: "Start voice assistant" }),
    );
    expect(synth.texts).toEqual([WELCOME_TEXT]);
    expect(synth.spoken[0].voice).toBe(LOCAL);
  });

  it("is not a turn: no agent call, no conversation id, no counter, no microphone, no upload", async () => {
    setup();
    await press("Start voice assistant");
    expect(sendTurn).not.toHaveBeenCalled();
    expect(uuid.calls).toBe(0);
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not start recording after the welcome, and returns to Tap to speak", async () => {
    setup();
    await press("Start voice assistant");
    expect(status()).toHaveTextContent("Speaking");
    browserStartsSpeaking();
    browserFinishesSpeaking();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(status()).toHaveTextContent("Ready");
    expect(
      screen.getByRole("button", { name: "Tap to speak" }),
    ).toBeInTheDocument();
  });

  it("keeps the welcome out of the model's history: the first turn is turn 1 with only the visitor's words", async () => {
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    expect(submissions()).toHaveLength(1);
    expect(submissions()[0].turnIndex).toBe(1);
    expect(submissions()[0].message).toBe("first take");
    expect(JSON.stringify(submissions())).not.toContain("workshop assistant");
  });

  it("turns on automatic reading of future replies only", async () => {
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    await screen.findByText(/Answer to: first take/);
    expect(synth.texts).toEqual([WELCOME_TEXT, "Answer to: first take"]);
  });

  it("does not read replies before Start, and does not read old ones after it", async () => {
    setup({ initialMode: "text" });
    fireEvent.change(screen.getByLabelText("Your message"), {
      target: { value: "hello" },
    });
    await press("Send message");
    await screen.findByText(/Answer to: hello/);
    expect(synth.spoken).toHaveLength(0); // Text never reads by itself

    await press("Voice");
    await press("Start voice assistant");

    // No second introduction, and the earlier reply stays silent.
    expect(synth.texts).toEqual([VOICE_READY_TEXT]);
  });

  it("never needs a second Start while the page lives, but a new page does", () => {
    const first = setup();
    first.unmount();
    setup();
    expect(
      screen.getByRole("button", { name: "Start voice assistant" }),
    ).toBeInTheDocument();
  });
});

describe("the stage follows the real flow", () => {
  it("goes Ready, Listening, Transcribing, Review, Thinking and Speaking", async () => {
    let finishTranscription: (value: Response) => void = () => undefined;
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("probe=1")
        ? Promise.resolve(
            new Response(JSON.stringify({ available: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          )
        : new Promise<Response>((resolve) => {
            finishTranscription = resolve;
          }),
    );
    let finishTurn: (outcome: TurnOutcome) => void = () => undefined;
    sendTurn.mockImplementation(
      () =>
        new Promise<TurnOutcome>((resolve) => {
          finishTurn = resolve;
        }),
    );
    setup();
    await startSession();
    expect(status()).toHaveTextContent("Ready");

    await press("Tap to speak");
    await screen.findByRole("button", { name: "Stop" });
    expect(status()).toHaveTextContent("Listening");
    expect(screen.getByRole("timer")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await press("Stop");
    await vi.waitFor(() => expect(status()).toHaveTextContent("Transcribing"));

    await act(async () => {
      finishTranscription(
        new Response(JSON.stringify({ text: "a spoken question" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    await vi.waitFor(() =>
      expect(status()).toHaveTextContent("Review what I heard"),
    );
    expect(heardBox()).toHaveValue("a spoken question");

    await press("Send what I said");
    expect(status()).toHaveTextContent("Thinking");
    expect(screen.getByRole("button", { name: "Please wait" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText(/a spoken question/)).toBeInTheDocument();

    await act(async () => {
      finishTurn(await answer(submissions()[0]));
    });
    expect(status()).toHaveTextContent("Speaking");
    expect(
      screen.getByRole("button", { name: "Stop speaking" }),
    ).toBeInTheDocument();

    browserStartsSpeaking();
    browserFinishesSpeaking();
    expect(status()).toHaveTextContent("Ready");
  });

  it("every state is written in words and has its own control, never colour alone", async () => {
    setup();
    await startSession();
    await press("Tap to speak");
    await screen.findByRole("button", { name: "Stop" });
    expect(status()).toHaveTextContent("Listening");
    expect(
      screen.getByRole("button", { name: "Cancel recording" }),
    ).toBeInTheDocument();
  });

  it("explains the permission wait with a way to cancel it", async () => {
    media.uninstall();
    media = installMedia({ auto: false });
    setup();
    await startSession();
    await press("Tap to speak");
    await vi.waitFor(() =>
      expect(status()).toHaveTextContent("Getting the microphone ready"),
    );
    await press("Cancel");
    expect(status()).toHaveTextContent("Ready");
  });

  it("does not announce messages repeatedly: only the one short state is live", async () => {
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    await screen.findByText(/Answer to: first take/);
    const live = screen
      .getAllByRole("status")
      .map((node) => node.textContent ?? "");
    expect(live.join(" ")).not.toContain("Answer to: first take");
  });
});

describe("a voice turn", () => {
  it("shows what it heard, editable, and sends nothing by itself", async () => {
    setup();
    await startSession();
    await recordUntilReview("first take");
    expect(
      screen.getByRole("button", { name: "Send what I said" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Record again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(sendTurn).not.toHaveBeenCalled(); // no auto-send
    expect(heardBox()).toHaveFocus();
  });

  it("sends exactly the text the visitor edited, once, and keeps it as the visitor's message", async () => {
    setup();
    await startSession();
    await recordUntilReview("first take");
    fireEvent.change(heardBox(), { target: { value: "an edited question" } });
    await press("Send what I said");
    expect(submissions().map((s) => s.message)).toEqual(["an edited question"]);
    const said = await screen.findByText(/You said:/);
    expect(said.parentElement).toHaveTextContent("an edited question");
  });

  it("sends from the keyboard with Enter, but not with Shift+Enter", async () => {
    setup();
    await startSession();
    await recordUntilReview("first take");
    await act(async () => {
      fireEvent.keyDown(heardBox(), { key: "Enter", shiftKey: true });
    });
    expect(sendTurn).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(heardBox(), { key: "Enter" });
    });
    expect(submissions()).toHaveLength(1);
  });

  it("hands focus to the main control when the review is sent or cancelled", async () => {
    setup();
    await startSession();
    await recordUntilReview("first take");
    expect(heardBox()).toHaveFocus();
    await press("Send what I said");
    expect(
      screen.getByRole("button", { name: /Please wait|Stop speaking/ }),
    ).toHaveFocus();

    await screen.findByText(/Answer to: first take/);
    browserStartsSpeaking();
    browserFinishesSpeaking();
    await recordUntilReview("second take");
    await press("Cancel");
    expect(screen.getByRole("button", { name: "Tap to speak" })).toHaveFocus();
  });

  it("will not send an empty message", async () => {
    setup();
    await startSession();
    await recordUntilReview("first take");
    fireEvent.change(heardBox(), { target: { value: "   " } });
    expect(
      screen.getByRole("button", { name: "Send what I said" }),
    ).toBeDisabled();
  });

  it("Cancel discards the transcript, sends nothing and goes back to Tap to speak", async () => {
    setup();
    await startSession();
    await recordUntilReview("first take");
    await press("Cancel");
    expect(sendTurn).not.toHaveBeenCalled();
    expect(
      screen.queryByLabelText("What I heard (you can edit it)"),
    ).toBeNull();
    expect(status()).toHaveTextContent("Ready");
    // A later review starts clean.
    await recordUntilReview("second take");
    expect(heardBox()).toHaveValue("second take");
  });

  it("Record again replaces the transcript only when the new one arrives", async () => {
    setup();
    await startSession();
    await recordUntilReview("first take");
    await press("Record again");
    await screen.findByRole("button", { name: "Stop" });
    // While recording, nothing has been replaced or sent.
    expect(sendTurn).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await press("Stop");
    await vi.waitFor(() => expect(heardBox()).toHaveValue("second take"));
  });

  it("Record again keeps the earlier transcript when the microphone is refused, and says why", async () => {
    setup();
    await startSession();
    await recordUntilReview("first take");
    refuseMicrophone("NotAllowedError");
    await press("Record again");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Microphone access is blocked",
    );
    expect(heardBox()).toHaveValue("first take"); // what was heard before is kept
    expect(
      screen.getByRole("button", { name: "Send what I said" }),
    ).toBeEnabled();
  });

  it("Record again keeps the earlier transcript when the transcription fails", async () => {
    setup();
    await startSession();
    await recordUntilReview("first take");
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("probe=1")
          ? new Response(JSON.stringify({ available: true }), { status: 200 })
          : new Response(JSON.stringify({ code: "no_speech" }), {
              status: 422,
              headers: { "content-type": "application/json" },
            }),
      ),
    );
    await press("Record again");
    await screen.findByRole("button", { name: "Stop" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await press("Stop");
    await screen.findByRole("alert");
    expect(heardBox()).toHaveValue("first take");
  });

  it("cannot record while the turn is being answered or spoken, except by stopping the voice", async () => {
    let finishTurn: (outcome: TurnOutcome) => void = () => undefined;
    sendTurn.mockImplementation(
      () =>
        new Promise<TurnOutcome>((resolve) => {
          finishTurn = resolve;
        }),
    );
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    // Thinking: the one control is disabled and does not start anything.
    const wait = screen.getByRole("button", { name: "Please wait" });
    const asked = media.getUserMedia.mock.calls.length;
    fireEvent.click(wait);
    expect(media.getUserMedia.mock.calls.length).toBe(asked);
    expect(screen.queryByRole("button", { name: "Tap to speak" })).toBeNull();

    await act(async () => {
      finishTurn(await answer(submissions()[0]));
    });
    // Speaking: Tap to speak is replaced by Stop speaking.
    expect(screen.queryByRole("button", { name: "Tap to speak" })).toBeNull();
    await press("Stop speaking");
    expect(
      screen.getByRole("button", { name: "Tap to speak" }),
    ).toBeInTheDocument();
  });
});

describe("reading replies aloud", () => {
  it("reads a new reply once, even when the page re-renders and the panels open and close", async () => {
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    await screen.findByText(/Answer to: first take/);
    browserStartsSpeaking();

    fireEvent.click(screen.getByRole("button", { name: "View transcript" }));
    fireEvent.click(screen.getByRole("button", { name: "Close transcript" }));
    fireEvent.click(screen.getByRole("button", { name: "Voice settings" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Close voice settings" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(
      synth.texts.filter((text) => text === "Answer to: first take"),
    ).toHaveLength(1);
  });

  it("Stop speaking silences it and keeps the text on screen", async () => {
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    await screen.findByText(/Answer to: first take/);
    const cancelled = synth.cancelCount;

    await press("Stop speaking");

    expect(synth.cancelCount).toBeGreaterThan(cancelled);
    expect(screen.getByText(/Answer to: first take/)).toBeInTheDocument();
    expect(status()).toHaveTextContent("Ready");
  });

  it("speaks the normalized date but shows the reply as written", async () => {
    sendTurn.mockImplementation(async (p: Pending) => ({
      kind: "ok",
      turn: agentTurn(p.turnIndex, {
        reply: {
          source: "assistant",
          text: "The first time is 2026-10-06 at 1:00 PM.",
        },
      }),
    }));
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    await screen.findByText(/The first time is 2026-10-06/);
    expect(synth.texts.at(-1)).toBe(
      "The first time is October 6, 2026 at 1:00 PM.",
    );
  });

  it("reads the observed slots reply naturally (U+2011 dates and ranges) and shows it as written", async () => {
    sendTurn.mockImplementation(async (p: Pending) => ({
      kind: "ok",
      turn: agentTurn(p.turnIndex, {
        reply: {
          source: "assistant",
          text: "Slots on 2026\u201110\u201108: 09:00\u201113:00 and 14:00\u201118:00.",
        },
      }),
    }));
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    await screen.findByText(/Slots on 2026\u201110\u201108/);
    expect(synth.texts.at(-1)).toBe(
      "Slots on October 8, 2026: from 9 AM to 1 PM and from 2 PM to 6 PM.",
    );
  });

  it("never reads a system notice", async () => {
    sendTurn.mockImplementation(async (p: Pending) => ({
      kind: "ok",
      turn: agentTurn(p.turnIndex, {
        outcome: "degraded",
        reply: { source: "system", text: "The assistant took too long." },
      }),
    }));
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    await screen.findByText(/The assistant took too long/);
    expect(synth.texts).toEqual([WELCOME_TEXT]);
  });

  it("never reads the proposal token, the review card or the timeline", async () => {
    sendTurn.mockImplementation(async (p: Pending) => ({
      kind: "ok",
      turn: reviewTurn(p.turnIndex, {
        reply: {
          source: "assistant",
          text: "The review is ready below. Nothing is booked until you confirm.",
        },
      }),
    }));
    const { container } = setup();
    await startSession();
    await speakToTheAssistant("first take");
    await screen.findByRole("button", { name: "Confirm booking" });

    expect(synth.texts.at(-1)).toBe(
      "The review is ready below. Nothing is booked until you confirm.",
    );
    expect(spoken()).not.toContain(TOKEN);
    expect(spoken()).not.toContain("Confirm booking");
    expect(spoken()).not.toContain("Review prepared by the schedule service");
    expect(container.textContent).not.toContain(TOKEN);
    expect(
      container.querySelectorAll('input[name="proposal_token"]'),
    ).toHaveLength(1);
  });

  it("does not mark a reply as read when the browser refuses to start, and offers to read it", async () => {
    setup();
    await startSession();
    synth.failSpeak = true; // for example an autoplay block
    await speakToTheAssistant("first take");
    await screen.findByText(/Answer to: first take/);

    expect(synth.spoken).toHaveLength(1); // only the welcome ever played
    const retry = screen.getByRole("button", { name: "Read reply aloud" });
    expect(status()).toHaveTextContent("Ready"); // not "Speaking": nothing began

    synth.failSpeak = false;
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(synth.texts.at(-1)).toBe("Answer to: first take");
    browserStartsSpeaking();
    expect(
      screen.queryByRole("button", { name: "Read reply aloud" }),
    ).toBeNull();
  });

  it("does not mark a reply as read when the first utterance fails after being queued", async () => {
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    await screen.findByText(/Answer to: first take/);
    act(() => synth.spoken[synth.spoken.length - 1].onerror?.());
    expect(
      screen.getByRole("button", { name: "Read reply aloud" }),
    ).toBeInTheDocument();
  });

  it("does not read when the voice is a network voice the visitor has not accepted", async () => {
    setup({ voices: [NETWORK] });
    await press("Start voice assistant");
    expect(synth.spoken).toHaveLength(0);
    expect(
      screen.getByText("Replies are not read aloud yet"),
    ).toBeInTheDocument();
    await speakToTheAssistant("first take");
    await screen.findByText(/Answer to: first take/);
    expect(synth.spoken).toHaveLength(0);

    await press("Use network voice");
    await press("Read reply aloud");
    expect(synth.texts).toEqual(["Answer to: first take"]);
    expect(synth.spoken[0].voice).toBe(NETWORK);
  });
});

describe("End voice session", () => {
  it("cancels speech, turns reading off and keeps the conversation and the review", async () => {
    sendTurn.mockImplementation(async (p: Pending) => ({
      kind: "ok",
      turn: reviewTurn(p.turnIndex),
    }));
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    await screen.findByRole("button", { name: "Confirm booking" });
    const cancelled = synth.cancelCount;

    await press("End voice session");

    expect(synth.cancelCount).toBeGreaterThan(cancelled);
    expect(
      screen.getByRole("button", { name: "Start voice assistant" }),
    ).toBeInTheDocument();
    // The review is not removed by ending the session.
    expect(
      screen.getByRole("button", { name: "Confirm booking" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "View transcript" }));
    const panel = screen.getByRole("complementary", { name: "Transcript" });
    expect(within(panel).getByText("first take")).toBeInTheDocument();
  });

  it("makes later replies silent until the visitor starts again", async () => {
    setup();
    await startSession();
    await press("End voice session");
    await press("Text");
    fireEvent.change(screen.getByLabelText("Your message"), {
      target: { value: "typed" },
    });
    await press("Send message");
    await screen.findByText(/Answer to: typed/);
    expect(synth.texts).toEqual([WELCOME_TEXT]);
  });

  it("stops a recording that is in progress and releases the microphone", async () => {
    setup();
    await startSession();
    await press("Tap to speak");
    await screen.findByRole("button", { name: "Stop" });
    await press("End voice session");
    expect(media.streams.every((stream) => stream.allStopped)).toBe(true);
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("discards a transcript that was waiting, but not the conversation", async () => {
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    await screen.findByText(/Answer to: first take/);
    browserStartsSpeaking();
    browserFinishesSpeaking();
    await recordUntilReview("second take");
    await press("End voice session");
    await press("Text");
    expect(screen.getByLabelText("Your message")).toHaveValue("");
    expect(screen.getByText("Answer to: first take")).toBeInTheDocument();
  });
});

describe("Voice and Text share one conversation", () => {
  it("keeps messages, the review and the draft when the visitor switches", async () => {
    sendTurn
      .mockImplementationOnce(answer)
      .mockImplementationOnce(async (p: Pending) => ({
        kind: "ok",
        turn: reviewTurn(p.turnIndex),
      }));
    setup();
    await startSession();
    await speakToTheAssistant("first take"); // voice, turn 1
    await screen.findByText(/Answer to: first take/);

    await press("Text");
    expect(screen.getByText("Answer to: first take")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Your message"), {
      target: { value: "the first time please" },
    });
    await press("Send message"); // text, turn 2 with a review
    await screen.findByRole("button", { name: "Confirm booking" });
    expect(submissions().map((s) => s.turnIndex)).toEqual([1, 2]);
    expect(new Set(submissions().map((s) => s.conversationId)).size).toBe(1);

    await press("Voice");
    expect(
      screen.getAllByRole("button", { name: "Confirm booking" }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Confirm booking" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "View transcript" }));
    const panel = screen.getByRole("complementary", { name: "Transcript" });
    expect(within(panel).getByText("first take")).toBeInTheDocument();
    expect(
      within(panel).getByText("the first time please"),
    ).toBeInTheDocument();
  });

  it("stops talking when the visitor leaves Voice, and Text never reads by itself", async () => {
    setup();
    await startSession();
    const cancelled = synth.cancelCount;
    await press("Text");
    expect(synth.cancelCount).toBeGreaterThan(cancelled);
  });

  it("keeps a message that was typed, and offers to review it from Voice", async () => {
    setup({ initialMode: "text" });
    fireEvent.change(screen.getByLabelText("Your message"), {
      target: { value: "half a thought" },
    });
    await press("Voice");
    expect(
      screen.getByText(/A message is waiting in Text/),
    ).toBeInTheDocument();
    await press("Review it in Text");
    expect(screen.getByLabelText("Your message")).toHaveValue("half a thought");
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("cancels a transcript that is waiting when the visitor switches to Text, and sends nothing", async () => {
    setup();
    await startSession();
    await recordUntilReview("first take");
    await press("Text");
    expect(screen.getByLabelText("Your message")).toHaveValue("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(sendTurn).not.toHaveBeenCalled();
  });
});

describe("the booking review in Voice", () => {
  beforeEach(() => {
    sendTurn.mockImplementation(async (p: Pending) => ({
      kind: "ok",
      turn: reviewTurn(p.turnIndex),
    }));
  });

  it("appears on the stage with the unchanged confirm form, and nothing is booked until pressed", async () => {
    const { container } = setup();
    await startSession();
    await speakToTheAssistant("first take");
    const confirm = await screen.findByRole("button", {
      name: "Confirm booking",
    });
    expect(
      screen.getByText(
        "Review prepared by the schedule service — nothing is booked until you confirm.",
      ),
    ).toBeInTheDocument();
    expect(confirmBooking).not.toHaveBeenCalled();
    const hidden = container.querySelectorAll('input[name="proposal_token"]');
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toHaveValue(TOKEN);
    expect(confirm).toBeEnabled();
  });

  it("is shown once: the transcript points to it instead of repeating the form", async () => {
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    await screen.findByRole("button", { name: "Confirm booking" });
    fireEvent.click(screen.getByRole("button", { name: "View transcript" }));
    const panel = screen.getByRole("complementary", { name: "Transcript" });
    expect(
      within(panel).queryByRole("button", { name: "Confirm booking" }),
    ).toBeNull();
    expect(panel).toHaveTextContent("open on the voice screen");
    expect(
      screen.getAllByRole("button", { name: "Confirm booking" }),
    ).toHaveLength(1);
  });

  it("keeps Review again working after an expired review", async () => {
    confirmBooking.mockResolvedValueOnce({ kind: "expired" });
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    await press("Confirm booking");
    const link = await screen.findByRole("link", { name: "Review again" });
    expect(link).toHaveAttribute(
      "href",
      "/assistant?service=flat-repair&date=2026-10-01",
    );
  });
});

describe("the compact toolbar", () => {
  it("keeps the panel buttons behind a labelled More button on small screens", () => {
    setup();
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveAttribute("aria-controls", "panel-menu");
    expect(document.getElementById("panel-menu")).toContainElement(
      screen.getByRole("button", { name: "View transcript" }),
    );
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "false");
  });

  it("stays open while a panel is open, so closing it can give focus back", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const opener = screen.getByRole("button", { name: "View transcript" });
    fireEvent.click(opener);
    expect(screen.getByRole("button", { name: "More" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close transcript" }));
    expect(opener).toHaveFocus();
  });
});

describe("the secondary panels", () => {
  it("shows the transcript on demand, with a text label for who spoke, scrolled to the latest", async () => {
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(840);
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    await screen.findByText(/Answer to: first take/);

    const opener = screen.getByRole("button", { name: "View transcript" });
    fireEvent.click(opener);
    const panel = screen.getByRole("complementary", { name: "Transcript" });
    expect(opener).toHaveAttribute("aria-expanded", "true");
    expect(within(panel).getByText("You")).toBeInTheDocument();
    expect(within(panel).getAllByText("Assistant (AI)").length).toBeGreaterThan(
      0,
    );
    expect(
      within(panel).getByRole("heading", { name: "Transcript" }),
    ).toHaveFocus();
    // The panel scrolls itself (not the page) to the newest content.
    const body = panel.querySelector(".overflow-y-auto") as HTMLElement;
    expect(body.scrollTop).toBe(840);
    scrollHeight.mockRestore();
  });

  it("returns focus to the control that opened it when it closes, by button or Escape", async () => {
    setup();
    const opener = screen.getByRole("button", { name: "View transcript" });
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Close transcript" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(opener).toHaveFocus();

    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("heading", { name: "Transcript" }), {
      key: "Escape",
    });
    expect(opener).toHaveFocus();
  });

  it("shows only the approved events in 'How this answer was made'", async () => {
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    await screen.findByText(/Answer to: first take/);
    fireEvent.click(
      screen.getByRole("button", { name: "How this answer was made" }),
    );
    const panel = screen.getByRole("complementary", {
      name: "How this answer was made",
    });
    expect(
      within(panel).getByRole("heading", { name: "Turn 1" }),
    ).toBeInTheDocument();
    expect(panel).toHaveTextContent("It never shows the assistant");
    expect(panel.textContent).not.toMatch(/prompt|chain-of-thought|token/i);
  });

  it("does not speak anything when focus moves or a panel opens", async () => {
    setup();
    await startSession();
    const count = synth.spoken.length;
    fireEvent.focus(screen.getByRole("button", { name: "Tap to speak" }));
    fireEvent.click(screen.getByRole("button", { name: "View transcript" }));
    fireEvent.click(screen.getByRole("button", { name: "Close transcript" }));
    expect(synth.spoken).toHaveLength(count);
  });
});

describe("Voice settings", () => {
  const open = () =>
    fireEvent.click(screen.getByRole("button", { name: "Voice settings" }));

  it("lists the device's English voices, says they depend on the browser, and shows the defaults", () => {
    setup({
      voices: [
        LOCAL,
        fakeVoice({ name: "Fine Natural voice" }),
        fakeVoice({ name: "Español", lang: "es-ES" }),
      ],
    });
    open();
    const select = screen.getByLabelText("Voice") as HTMLSelectElement;
    const options = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options[0]).toContain("Recommended");
    expect(options.join("|")).toContain("Fine Natural voice");
    expect(options.join("|")).not.toContain("Español");
    expect(select.value).toBe("");
    expect(screen.getByLabelText(/Speed: 0.95/)).toHaveValue("0.95");
    expect(
      screen.getByText(/Voices come from your browser and your device/),
    ).toBeInTheDocument();
  });

  it("changes the voice and the speed, remembers only those two, and uses them", async () => {
    setup({ voices: [LOCAL, fakeVoice({ name: "Fine Natural voice" })] });
    open();
    fireEvent.change(screen.getByLabelText("Voice"), {
      target: { value: "Local voice" },
    });
    fireEvent.change(screen.getByLabelText(/Speed/), {
      target: { value: "1.2" },
    });
    expect(
      JSON.parse(localStorage.getItem("quillwheel.voice-settings.v1") ?? ""),
    ).toEqual({
      voiceName: "Local voice",
      rate: 1.2,
      consentVoice: null,
      reviewBeforeSending: true,
    });

    await press("Preview voice");
    expect(synth.texts).toEqual([PREVIEW_TEXT]);
    expect(synth.spoken[0]).toMatchObject({ voice: LOCAL, rate: 1.2 });
    // Nothing from the conversation is stored.
    await press("Close voice settings");
    expect(localStorage.length).toBe(1);
  });

  it("Preview voice sends nothing to the assistant and can be stopped", async () => {
    setup();
    open();
    await press("Preview voice");
    expect(sendTurn).not.toHaveBeenCalled();
    expect(uuid.calls).toBe(0);
    await press("Stop preview");
    expect(
      screen.getByRole("button", { name: "Preview voice" }),
    ).toBeInTheDocument();
  });

  it("restores the defaults and forgets what was remembered", () => {
    setup({ voices: [LOCAL, fakeVoice({ name: "Fine Natural voice" })] });
    open();
    fireEvent.change(screen.getByLabelText("Voice"), {
      target: { value: "Local voice" },
    });
    fireEvent.change(screen.getByLabelText(/Speed/), {
      target: { value: "1.2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));
    expect((screen.getByLabelText("Voice") as HTMLSelectElement).value).toBe(
      "",
    );
    expect(screen.getByLabelText(/Speed: 0.95/)).toBeInTheDocument();
    expect(localStorage.getItem("quillwheel.voice-settings.v1")).toBeNull();
  });

  it("uses a valid remembered voice and speed", () => {
    localStorage.setItem(
      "quillwheel.voice-settings.v1",
      JSON.stringify({ voiceName: "Fine Natural voice", rate: 1.1 }),
    );
    setup({ voices: [LOCAL, fakeVoice({ name: "Fine Natural voice" })] });
    open();
    expect((screen.getByLabelText("Voice") as HTMLSelectElement).value).toBe(
      "Fine Natural voice",
    );
    expect(screen.getByLabelText(/Speed: 1.10/)).toBeInTheDocument();
  });

  it.each([
    ["not JSON", "{{nope"],
    ["wrong types", JSON.stringify({ voiceName: 7, rate: "fast" })],
    ["an out-of-range speed", JSON.stringify({ voiceName: null, rate: 40 })],
  ])("ignores a remembered value that is %s", (_label, raw) => {
    localStorage.setItem("quillwheel.voice-settings.v1", raw);
    setup();
    open();
    expect((screen.getByLabelText("Voice") as HTMLSelectElement).value).toBe(
      "",
    );
    expect(screen.getByLabelText(/Speed: 0.95/)).toBeInTheDocument();
  });

  it("falls back to the automatic voice when the remembered one is gone", async () => {
    localStorage.setItem(
      "quillwheel.voice-settings.v1",
      JSON.stringify({ voiceName: "Vanished", rate: 1 }),
    );
    setup();
    open();
    expect((screen.getByLabelText("Voice") as HTMLSelectElement).value).toBe(
      "",
    );
    await press("Preview voice");
    expect(synth.spoken[0].voice).toBe(LOCAL); // still speaks
  });

  it("updates when the browser loads its voices late (voiceschanged)", () => {
    setup({ voices: [] });
    open();
    expect(screen.queryByLabelText("Voice")).toBeNull();
    expect(screen.getByText(/no English voice to offer/)).toBeInTheDocument();
    act(() => synth.setVoices([LOCAL]));
    expect(screen.getByLabelText("Voice")).toBeInTheDocument();
  });

  it("marks a network voice and needs the visitor's agreement before using it", async () => {
    setup({ voices: [LOCAL, NETWORK] });
    open();
    const names = within(screen.getByLabelText("Voice"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(names.join("|")).toContain("Network voice (en-US) — Network voice");
    fireEvent.change(screen.getByLabelText("Voice"), {
      target: { value: "Network voice" },
    });
    expect(screen.getByText("You picked a network voice")).toBeInTheDocument();
    await press("Preview voice");
    expect(synth.spoken).toHaveLength(0);
    await press("Use network voice");
    await press("Preview voice");
    expect(synth.spoken[0].voice).toBe(NETWORK);
  });
});

describe("when voice is not available", () => {
  it("offers Text, plainly, when the browser cannot record, and Text works", async () => {
    media.uninstall();
    setup();
    expect(
      await screen.findByRole("heading", {
        name: "Voice isn't available here",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Start voice assistant" }),
    ).toBeNull();
    expect(synth.spoken).toHaveLength(0);
    await press("Switch to Text");
    fireEvent.change(screen.getByLabelText("Your message"), {
      target: { value: "typed" },
    });
    await press("Send message");
    expect(await screen.findByText(/Answer to: typed/)).toBeInTheDocument();
  });

  it("works without speech synthesis: it says replies stay on screen and does not pretend", async () => {
    vi.unstubAllGlobals(); // no speechSynthesis in jsdom
    vi.stubGlobal("fetch", fetchMock);
    media.uninstall();
    media = installMedia();
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ reviewBeforeSending: true }),
    );
    resetSpeechOutput();
    render(<ChatPanel assumeReady />);
    await press("Start voice assistant");
    expect(screen.getByText(/can't read replies aloud/)).toBeInTheDocument();
    await speakToTheAssistant("first take");
    expect(
      await screen.findByText(/Answer to: first take/),
    ).toBeInTheDocument();
  });

  it("works with no usable voice and keeps the replies as text", async () => {
    setup({ voices: [] });
    await press("Start voice assistant");
    expect(synth.spoken).toHaveLength(0);
    expect(screen.getByText(/can't read replies aloud/)).toBeInTheDocument();
    await speakToTheAssistant("first take");
    expect(
      await screen.findByText(/Answer to: first take/),
    ).toBeInTheDocument();
    expect(synth.spoken).toHaveLength(0);
  });

  it("explains a refused microphone, lets the visitor retry or use Text, and loses nothing", async () => {
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    await screen.findByText(/Answer to: first take/);
    browserFinishesSpeaking();

    refuseMicrophone("NotAllowedError");
    await press("Tap to speak");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Microphone access is blocked");
    expect(alert).toHaveTextContent("switch to Text");
    expect(screen.getByText(/Answer to: first take/)).toBeInTheDocument();

    // Retry works once the permission is granted.
    await recordUntilReview("second take");
    expect(heardBox()).toHaveValue("second take");
    await press("Cancel");

    refuseMicrophone("NotAllowedError");
    await press("Tap to speak");
    await screen.findByRole("alert");
    await press("Switch to Text");
    expect(screen.getByText("Answer to: first take")).toBeInTheDocument();
  });

  it("explains a missing microphone device", async () => {
    setup();
    await startSession();
    refuseMicrophone("NotFoundError");
    await press("Tap to speak");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No microphone was found",
    );
  });

  it("shows agent_unavailable as a notice with Try again and Back to workshop, in Voice", async () => {
    sendTurn.mockResolvedValueOnce({ kind: "agent_unavailable" });
    setup();
    await startSession();
    await speakToTheAssistant("first take");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The assistant isn't switched on");
    expect(
      screen.getByRole("link", { name: "Back to workshop" }),
    ).toHaveAttribute("href", "/");
    await press("Try again");
    expect(submissions().map((s) => s.message)).toEqual([
      "first take",
      "first take",
    ]);
    expect(
      await screen.findByText(/Answer to: first take/),
    ).toBeInTheDocument();
  });
});

describe("layout contract", () => {
  it("keeps scrolling inside the stage and the panels, never in a page-level container", async () => {
    const { container } = setup();
    const stage = screen.getByRole("region", { name: "Voice assistant" });
    expect(stage.className).toContain("overflow-y-auto");
    expect(stage.className).toContain("h-full");
    fireEvent.click(screen.getByRole("button", { name: "View transcript" }));
    const panel = screen.getByRole("complementary", { name: "Transcript" });
    expect(panel.className).toContain("h-full");
    expect(panel.querySelector(".overflow-y-auto")).not.toBeNull();
    // The component root fills its parent; it never sets a height of its own.
    expect((container.firstElementChild as HTMLElement).className).toContain(
      "h-full",
    );
  });
});

describe("accessibility", () => {
  it("has no axe violations in the start, ready, review and speaking states", async () => {
    const { container } = setup();
    await expectNoA11yViolations(container); // start
    await startSession();
    await expectNoA11yViolations(container); // ready
    await recordUntilReview("first take");
    await expectNoA11yViolations(container); // review
    await press("Send what I said");
    await screen.findByText(/Answer to: first take/);
    await expectNoA11yViolations(container); // speaking
  });

  it("has no axe violations with the booking review, the panels and an error", async () => {
    sendTurn.mockImplementation(async (p: Pending) => ({
      kind: "ok",
      turn: reviewTurn(p.turnIndex),
    }));
    const { container } = setup();
    await startSession();
    await speakToTheAssistant("first take");
    await screen.findByRole("button", { name: "Confirm booking" });
    await expectNoA11yViolations(container);

    fireEvent.click(screen.getByRole("button", { name: "View transcript" }));
    await expectNoA11yViolations(container);
    fireEvent.click(screen.getByRole("button", { name: "Close transcript" }));
    fireEvent.click(screen.getByRole("button", { name: "Voice settings" }));
    await expectNoA11yViolations(container);
    fireEvent.click(
      screen.getByRole("button", { name: "Close voice settings" }),
    );

    refuseMicrophone("NotAllowedError");
    browserFinishesSpeaking();
    await press("Tap to speak");
    await screen.findByRole("alert");
    await expectNoA11yViolations(container);
  });

  it("every control has a name and nothing is trapped: Tab order is the DOM order", async () => {
    const { container } = setup();
    await startSession();
    const controls = container.querySelectorAll(
      "button, a, input, select, textarea",
    );
    for (const control of controls) {
      expect(control).not.toHaveAttribute("tabindex", "1");
      const name =
        control.getAttribute("aria-label") ??
        control.textContent?.trim() ??
        (control as HTMLInputElement).labels?.[0]?.textContent;
      expect(name).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Automatic sending (the default), the short start, network-voice agreement and the live orb.
// ---------------------------------------------------------------------------------------------

const NET_A = fakeVoice({ name: "Net Alpha", localService: false });
const NET_B = fakeVoice({ name: "Net Beta", localService: false });

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Records a clip and stops it; the transcription is whatever the fetch mock answers. */
async function recordAndStop() {
  await press("Tap to speak");
  await screen.findByRole("button", { name: "Stop" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  await press("Stop");
}

/** Holds the transcription request until the test lets it finish. */
function holdTranscription() {
  let finish: (response: Response) => void = () => undefined;
  fetchMock.mockImplementation((url: string) =>
    String(url).includes("probe=1")
      ? Promise.resolve(jsonResponse({ available: true }))
      : new Promise<Response>((resolve) => {
          finish = resolve;
        }),
  );
  return {
    finish: async (text: string) => {
      await act(async () => {
        finish(jsonResponse({ text }));
      });
    },
  };
}

function holdTurn() {
  let finish: (outcome: TurnOutcome) => void = () => undefined;
  sendTurn.mockImplementation(
    () =>
      new Promise<TurnOutcome>((resolve) => {
        finish = resolve;
      }),
  );
  return {
    finish: async () => {
      const outcome = await answer(submissions()[0]);
      await act(async () => {
        finish(outcome);
      });
    },
  };
}

describe("automatic sending (the default)", () => {
  it("is on by default: Review transcript before sending starts off", () => {
    setup({ review: false });
    fireEvent.click(screen.getByRole("button", { name: "Voice settings" }));
    expect(
      screen.getByRole("checkbox", {
        name: "Review transcript before sending",
      }),
    ).not.toBeChecked();
  });

  it("goes from Transcribing straight to Thinking and sends the heard sentence as the next turn, with no editor and no Send", async () => {
    const held = holdTranscription();
    const turn = holdTurn();
    setup({ review: false });
    await startSession();

    await recordAndStop();
    await vi.waitFor(() => expect(status()).toHaveTextContent("Transcribing"));
    expect(screen.getByText(/sent as soon as it is ready/)).toBeInTheDocument();
    expect(sendTurn).not.toHaveBeenCalled();

    await held.finish("when are you open on Tuesday");
    expect(status()).toHaveTextContent("Thinking");
    expect(
      screen.queryByLabelText("What I heard (you can edit it)"),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Send what I said" }),
    ).toBeNull();
    expect(submissions()).toHaveLength(1);
    expect(submissions()[0]).toMatchObject({
      turnIndex: 1,
      message: "when are you open on Tuesday",
    });
    // The visitor sees what was heard, briefly, as context for the wait.
    expect(screen.getByText(/You said:/).parentElement).toHaveTextContent(
      "when are you open on Tuesday",
    );
    expect(screen.getByText(/I heard you and sent it/)).toBeInTheDocument();

    await turn.finish();
    expect(status()).toHaveTextContent("Speaking");
    expect(synth.texts.at(-1)).toBe("Answer to: when are you open on Tuesday");
    browserStartsSpeaking();
    browserFinishesSpeaking();
    expect(status()).toHaveTextContent("Ready");
  });

  it("reads the new reply once, and never a second one for the same turn", async () => {
    setup({ review: false });
    await startSession();
    await recordAndStop();
    await screen.findByText(/Answer to: first take/);
    browserStartsSpeaking();
    fireEvent.click(screen.getByRole("button", { name: "View transcript" }));
    fireEvent.click(screen.getByRole("button", { name: "Close transcript" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(
      synth.texts.filter((text) => text === "Answer to: first take"),
    ).toHaveLength(1);
    expect(submissions()).toHaveLength(1); // and it was sent once
  });

  it("blocks a second recording while the turn is in progress", async () => {
    const turn = holdTurn();
    setup({ review: false });
    await startSession();
    await recordAndStop();
    await vi.waitFor(() => expect(status()).toHaveTextContent("Thinking"));
    const asked = media.getUserMedia.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Please wait" }));
    expect(media.getUserMedia.mock.calls.length).toBe(asked);
    expect(screen.queryByRole("button", { name: "Tap to speak" })).toBeNull();
    await turn.finish();
    expect(submissions()).toHaveLength(1);
  });

  it("never confirms a booking: the review appears and Confirm booking waits for a press", async () => {
    sendTurn.mockImplementation(async (p: Pending) => ({
      kind: "ok",
      turn: reviewTurn(p.turnIndex),
    }));
    setup({ review: false });
    await startSession();
    await recordAndStop();
    const confirm = await screen.findByRole("button", {
      name: "Confirm booking",
    });
    expect(confirm).toBeEnabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(confirmBooking).not.toHaveBeenCalled();
  });

  it("does not send an empty transcript", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        jsonResponse(
          String(url).includes("probe=1")
            ? { available: true }
            : { text: "   " },
        ),
      ),
    );
    setup({ review: false });
    await startSession();
    await recordAndStop();
    await vi.waitFor(() =>
      expect(screen.getByText(/I didn't hear anything/)).toBeInTheDocument(),
    );
    expect(sendTurn).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Tap to speak" }),
    ).toBeInTheDocument();
  });

  it("does not send when the transcription fails", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("probe=1")
          ? jsonResponse({ available: true })
          : jsonResponse({ error: "no_speech" }, 422),
      ),
    );
    setup({ review: false });
    await startSession();
    await recordAndStop();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No speech was found",
    );
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("does not send a recording that was cancelled, while recording or while transcribing", async () => {
    const held = holdTranscription();
    setup({ review: false });
    await startSession();

    await press("Tap to speak");
    await screen.findByRole("button", { name: "Stop" });
    await press("Cancel recording");
    expect(sendTurn).not.toHaveBeenCalled();

    await recordAndStop();
    await vi.waitFor(() => expect(status()).toHaveTextContent("Transcribing"));
    await press("Cancel transcription");
    await held.finish("too late");
    expect(sendTurn).not.toHaveBeenCalled();
    expect(status()).toHaveTextContent("Ready");
  });

  it("does not send if the voice session ended before the transcription finished", async () => {
    const held = holdTranscription();
    setup({ review: false });
    await startSession();
    await recordAndStop();
    await vi.waitFor(() => expect(status()).toHaveTextContent("Transcribing"));
    await press("End voice session");
    await held.finish("too late");
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("does not send if the visitor moved to Text during Listening or Transcribing", async () => {
    const held = holdTranscription();
    setup({ review: false });
    await startSession();

    await press("Tap to speak");
    await screen.findByRole("button", { name: "Stop" });
    await press("Text");
    expect(media.streams.every((stream) => stream.allStopped)).toBe(true);
    expect(sendTurn).not.toHaveBeenCalled();

    await press("Voice");
    await startSession();
    await recordAndStop();
    await vi.waitFor(() => expect(status()).toHaveTextContent("Transcribing"));
    await press("Text");
    await held.finish("too late");
    expect(sendTurn).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Your message")).toHaveValue("");
  });

  it("lets a turn that was already sent finish in Text, shows its reply, and does not read it", async () => {
    const turn = holdTurn();
    setup({ review: false });
    await startSession();
    await recordAndStop();
    await vi.waitFor(() => expect(status()).toHaveTextContent("Thinking"));
    await press("Text");
    const cancelled = synth.cancelCount;

    await turn.finish();

    expect(
      await screen.findByText("Answer to: first take"),
    ).toBeInTheDocument();
    expect(synth.texts).toEqual([WELCOME_TEXT]); // the welcome only: the reply is not read
    expect(synth.cancelCount).toBeGreaterThanOrEqual(cancelled);
    // Back in Voice the session must be started again, and nothing old is read.
    await press("Voice");
    expect(
      screen.getByRole("button", { name: "Start voice assistant" }),
    ).toBeInTheDocument();
    await press("Start voice assistant");
    expect(synth.texts).toEqual([WELCOME_TEXT, VOICE_READY_TEXT]);
  });

  it("keeps a message typed in Text safe: the transcript goes to the review instead of replacing it", async () => {
    setup({ initialMode: "text", review: false });
    fireEvent.change(screen.getByLabelText("Your message"), {
      target: { value: "half a thought" },
    });
    await press("Voice");
    await startSession();
    await recordAndStop();
    await vi.waitFor(() => expect(heardBox().value).toContain("first take"));
    expect(heardBox().value).toContain("half a thought");
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("falls back to the review when the heard text cannot be sent (too long)", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        jsonResponse(
          String(url).includes("probe=1")
            ? { available: true }
            : { text: "word ".repeat(120) },
        ),
      ),
    );
    setup({ review: false });
    await startSession();
    await recordAndStop();
    await vi.waitFor(() => expect(heardBox()).toBeInTheDocument());
    expect(sendTurn).not.toHaveBeenCalled();
  });
});

describe("Review transcript before sending", () => {
  it("turned on, keeps the manual review exactly: edit, Send what I said, no auto-send", async () => {
    setup({ review: false });
    fireEvent.click(screen.getByRole("button", { name: "Voice settings" }));
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Review transcript before sending",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Close voice settings" }),
    );
    expect(
      JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}")
        .reviewBeforeSending,
    ).toBe(true);

    await startSession();
    await recordUntilReview("first take");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(sendTurn).not.toHaveBeenCalled();
    fireEvent.change(heardBox(), { target: { value: "edited" } });
    await press("Send what I said");
    expect(submissions().map((s) => s.message)).toEqual(["edited"]);
  });

  it("is remembered with the other voice preferences and contains no conversation", async () => {
    setup({ review: false });
    await startSession();
    await recordAndStop();
    await screen.findByText(/Answer to: first take/);
    fireEvent.click(screen.getByRole("button", { name: "Voice settings" }));
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Review transcript before sending",
      }),
    );
    const stored = localStorage.getItem(SETTINGS_KEY) ?? "";
    expect(Object.keys(JSON.parse(stored)).sort()).toEqual([
      "consentVoice",
      "rate",
      "reviewBeforeSending",
      "voiceName",
    ]);
    expect(stored).not.toContain("first take");
  });

  it.each([
    ["a string", '{"reviewBeforeSending":"true"}'],
    ["a number", '{"reviewBeforeSending":1}'],
    ["not JSON", "{{"],
  ])(
    "treats %s as the default, which is automatic sending",
    async (_label, raw) => {
      localStorage.setItem(SETTINGS_KEY, raw);
      setup({ review: false });
      await startSession();
      await recordAndStop();
      await screen.findByText(/Answer to: first take/);
      expect(submissions()).toHaveLength(1);
    },
  );

  it("sends nothing about the preference to the server", async () => {
    setup({ review: false });
    fireEvent.click(screen.getByRole("button", { name: "Voice settings" }));
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Review transcript before sending",
      }),
    );
    fireEvent.change(screen.getByLabelText("Voice"), { target: { value: "" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendTurn).not.toHaveBeenCalled();
  });
});

describe("Start voice assistant in a conversation that already has messages", () => {
  it("says only that voice mode is ready: no new introduction, no history, no turn", async () => {
    setup({ initialMode: "text", review: false });
    fireEvent.change(screen.getByLabelText("Your message"), {
      target: { value: "hello" },
    });
    await press("Send message");
    await screen.findByText(/Answer to: hello/);
    const ids = uuid.calls;
    const turns = sendTurn.mock.calls.length;

    await press("Voice");
    await press("Start voice assistant");

    expect(synth.texts).toEqual([VOICE_READY_TEXT]);
    expect(spoken()).not.toContain("hello");
    expect(spoken()).not.toContain("workshop assistant");
    expect(sendTurn.mock.calls.length).toBe(turns);
    expect(uuid.calls).toBe(ids);
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });

  it("keeps reading future replies after the short start", async () => {
    setup({ initialMode: "text", review: false });
    fireEvent.change(screen.getByLabelText("Your message"), {
      target: { value: "hello" },
    });
    await press("Send message");
    await screen.findByText(/Answer to: hello/);
    await press("Voice");
    await startSession();
    await recordAndStop();
    await screen.findByText(/Answer to: first take/);
    expect(synth.texts).toEqual([VOICE_READY_TEXT, "Answer to: first take"]);
  });

  it("uses the full introduction for an empty conversation, and counts a welcome-only conversation as empty", async () => {
    setup({ review: false });
    await startSession();
    expect(synth.texts).toEqual([WELCOME_TEXT]);
    await press("End voice session");
    await press("Start voice assistant");
    expect(synth.texts).toEqual([WELCOME_TEXT, WELCOME_TEXT]);
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("does not show the whole history on the voice stage, only the latest exchange", async () => {
    setup({ review: false });
    await startSession();
    await recordAndStop();
    await screen.findByText(/Answer to: first take/);
    browserStartsSpeaking();
    browserFinishesSpeaking();
    await recordAndStop();
    await screen.findByText(/Answer to: second take/);
    const stage = screen.getByRole("region", { name: "Voice assistant" });
    expect(within(stage).queryByText(/Answer to: first take/)).toBeNull();
    expect(within(stage).queryByText(/first take/)).toBeNull();
    expect(
      within(stage).getByText(/Answer to: second take/),
    ).toBeInTheDocument();
    // The whole conversation is one press away.
    fireEvent.click(screen.getByRole("button", { name: "View transcript" }));
    const panel = screen.getByRole("complementary", { name: "Transcript" });
    expect(within(panel).getByText("first take")).toBeInTheDocument();
    expect(within(panel).getByText("second take")).toBeInTheDocument();
  });

  it("does not announce the same messages twice while the transcript is open", async () => {
    setup({ review: false });
    await startSession();
    await recordAndStop();
    await screen.findByText(/Answer to: first take/);
    const card = () =>
      screen.getByLabelText("Latest exchange", { selector: "section" });
    expect(card()).not.toHaveAttribute("aria-hidden");
    fireEvent.click(screen.getByRole("button", { name: "View transcript" }));
    expect(
      document.querySelector('section[aria-label="Latest exchange"]'),
    ).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(screen.getByRole("button", { name: "Close transcript" }));
    expect(card()).not.toHaveAttribute("aria-hidden");
  });

  it("shows the booking review once, not on the stage and again in the transcript", async () => {
    sendTurn.mockImplementation(async (p: Pending) => ({
      kind: "ok",
      turn: reviewTurn(p.turnIndex),
    }));
    const { container } = setup({ review: false });
    await startSession();
    await recordAndStop();
    await screen.findByRole("button", { name: "Confirm booking" });
    fireEvent.click(screen.getByRole("button", { name: "View transcript" }));
    expect(
      screen.getAllByRole("button", { name: "Confirm booking" }),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('input[name="proposal_token"]'),
    ).toHaveLength(1);
  });
});

describe("leaving Voice for Text", () => {
  it("ends the session, silences speech and keeps the conversation and the review", async () => {
    sendTurn.mockImplementation(async (p: Pending) => ({
      kind: "ok",
      turn: reviewTurn(p.turnIndex),
    }));
    setup({ review: false });
    await startSession();
    await recordAndStop();
    await screen.findByRole("button", { name: "Confirm booking" });
    const cancelled = synth.cancelCount;

    await press("Text");

    expect(synth.cancelCount).toBeGreaterThan(cancelled);
    expect(
      screen.getByRole("button", { name: "Confirm booking" }),
    ).toBeEnabled();
    expect(screen.getByText("first take")).toBeInTheDocument();
    await press("Voice");
    expect(
      screen.getByRole("button", { name: "Start voice assistant" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm booking" }),
    ).toBeEnabled();
  });
});

describe("network voices", () => {
  const open = () =>
    fireEvent.click(screen.getByRole("button", { name: "Voice settings" }));
  const pick = (name: string) =>
    fireEvent.change(screen.getByLabelText("Voice"), {
      target: { value: name },
    });

  it("explains what a network voice is, in plain words, without naming a provider's data practices", () => {
    setup({ voices: [LOCAL, NET_A], review: false });
    open();
    pick("Net Alpha");
    expect(
      screen.getByText(
        /A network voice may send the text to your browser’s voice provider to generate audio\. It requires an internet connection\./,
      ),
    ).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Google|Microsoft|Amazon|retain|stores? your/i);
  });

  it("shows the exact voice in use and whether it is local or network", () => {
    setup({ voices: [LOCAL, NET_A], review: false });
    open();
    const current = screen.getByTestId("current-voice");
    expect(current).toHaveTextContent("Local voice");
    expect(current).toHaveTextContent("Local voice");
    pick("Net Alpha");
    expect(screen.getByTestId("current-voice")).toHaveTextContent("Net Alpha");
    expect(screen.getByTestId("current-voice")).toHaveTextContent(
      "Network voice",
    );
  });

  it("is never used before the visitor agrees, and the agreement for a voice they picked is remembered for that voice", async () => {
    const view = setup({ voices: [LOCAL, NET_A], review: false });
    open();
    pick("Net Alpha");
    await press("Preview voice");
    expect(synth.spoken).toHaveLength(0);

    await press("Use network voice");
    expect(
      JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}"),
    ).toMatchObject({ voiceName: "Net Alpha", consentVoice: "Net Alpha" });
    expect(
      screen.getByText(/remembered in this browser for this voice only/),
    ).toBeInTheDocument();

    // A later visit: the same voice is used without asking again.
    view.unmount();
    setup({ voices: [LOCAL, NET_A], review: false });
    await press("Start voice assistant");
    expect(synth.texts).toEqual([WELCOME_TEXT]);
    expect(synth.spoken[0].voice).toBe(NET_A);
  });

  it("does not carry the agreement to another network voice", async () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ voiceName: "Net Alpha", consentVoice: "Net Alpha" }),
    );
    setup({ voices: [LOCAL, NET_A, NET_B], review: false });
    open();
    pick("Net Beta");
    expect(screen.getByText("You picked a network voice")).toBeInTheDocument();
    await press("Preview voice");
    expect(synth.spoken).toHaveLength(0);
    expect(
      JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}").consentVoice,
    ).toBeNull();
  });

  it("does not remember an agreement for a voice nobody picked (only a network voice exists)", async () => {
    setup({ voices: [NET_A], review: false });
    open();
    expect(
      screen.getByText("Only a network voice is available"),
    ).toBeInTheDocument();
    await press("Use network voice");
    await press("Preview voice");
    expect(synth.spoken[0].voice).toBe(NET_A);
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
  });

  it("lets the visitor withdraw the agreement and go back to the recommended voice", async () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ voiceName: "Net Alpha", consentVoice: "Net Alpha" }),
    );
    setup({ voices: [LOCAL, NET_A], review: false });
    open();
    await press("Stop using network voice");
    expect(
      JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}").consentVoice,
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Use network voice" }),
    ).toBeInTheDocument();

    await press("Back to the recommended voice");
    expect((screen.getByLabelText("Voice") as HTMLSelectElement).value).toBe(
      "",
    );
    expect(screen.getByTestId("current-voice")).toHaveTextContent(
      "Local voice",
    );
  });

  it("falls back to a local voice, and still speaks, when the remembered network voice disappears", async () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ voiceName: "Net Alpha", consentVoice: "Net Alpha" }),
    );
    setup({ voices: [LOCAL], review: false });
    open();
    expect((screen.getByLabelText("Voice") as HTMLSelectElement).value).toBe(
      "",
    );
    expect(screen.getByTestId("current-voice")).toHaveTextContent(
      "Local voice",
    );
    await press("Preview voice");
    expect(synth.spoken[0].voice).toBe(LOCAL);
  });

  it("keeps the voice list and the preference in the browser: nothing is sent to the server", async () => {
    setup({ voices: [LOCAL, NET_A], review: false });
    open();
    pick("Net Alpha");
    await press("Use network voice");
    await press("Preview voice");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendTurn).not.toHaveBeenCalled();
  });
});

describe("the live orb in the stage", () => {
  it("analyses the recording's own stream while Listening and releases everything afterwards", async () => {
    const frames = installAudio();
    try {
      setup({ review: false });
      await startSession();
      expect(FakeAudioContext.instances).toHaveLength(0);

      await press("Tap to speak");
      await screen.findByRole("button", { name: "Stop" });
      expect(FakeAudioContext.instances).toHaveLength(1);
      expect(media.getUserMedia).toHaveBeenCalledTimes(1); // no second capture
      expect(frames.pending()).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await press("Stop");
      const [context] = FakeAudioContext.instances;
      expect(context.closed).toBe(true);
      expect(frames.pending()).toBe(0);
      expect(media.streams.every((stream) => stream.allStopped)).toBe(true);
    } finally {
      frames.uninstall();
    }
  });

  it("works without Web Audio: the same states, no analyser", async () => {
    setup({ review: false });
    await startSession();
    await press("Tap to speak");
    await screen.findByRole("button", { name: "Stop" });
    expect(status()).toHaveTextContent("Listening");
    expect(
      document.querySelector("[data-orb-stage='listening']"),
    ).not.toBeNull();
  });
});
