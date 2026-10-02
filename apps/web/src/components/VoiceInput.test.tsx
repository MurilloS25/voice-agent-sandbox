import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoA11yViolations } from "@/test/axe";
import { FakeRecorder, installMedia, type FakeMedia } from "@/test/voice-fakes";

import { VoiceInput, type VoiceControl } from "./VoiceInput";

const fetchMock = vi.fn();
let media: FakeMedia;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

type Serve = {
  available?: boolean;
  text?: string;
  transcribe?: (init: RequestInit) => Promise<Response>;
};

/** A stand-in for the same-origin route: a probe answer and a transcription answer. */
function serve({
  available = true,
  text = "Book a flat repair",
  transcribe,
}: Serve = {}) {
  fetchMock.mockImplementation((url: string, init: RequestInit) => {
    if (url.includes("probe=1")) return Promise.resolve(json({ available }));
    return transcribe ? transcribe(init) : Promise.resolve(json({ text }));
  });
}

/** A transcription that never answers until its signal aborts. */
function hang(): { signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  serve({
    transcribe: (init) =>
      new Promise((_resolve, reject) => {
        signals.push(init.signal as AbortSignal);
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  });
  return { signals };
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const speak = () => screen.getByRole("button", { name: "Speak" });

async function press(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

/** Lets some recording time pass (the minimum is 0.3 s), then presses Stop. */
async function stopRecording(afterMs = 1000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(afterMs);
  });
  await press("Stop");
}

async function startRecording(name: string = "Speak") {
  await press(name);
  return screen.findByRole("button", { name: "Stop" });
}

function mount(props: Partial<Parameters<typeof VoiceInput>[0]> = {}) {
  const onTranscript = vi.fn();
  const view = render(<VoiceInput onTranscript={onTranscript} {...props} />);
  return { onTranscript, ...view };
}

describe("before anything is pressed", () => {
  it("offers Speak, explains where the audio goes and asks for nothing", () => {
    serve();
    mount();

    expect(speak()).toBeEnabled();
    expect(screen.getByText(/doesn't store it/)).toBeInTheDocument();
    expect(screen.getByText(/15 seconds/)).toBeInTheDocument();
    expect(media.getUserMedia).not.toHaveBeenCalled(); // no microphone request on load
    expect(fetchMock).not.toHaveBeenCalled(); // and no request of any kind
    expect(document.body).toHaveFocus();
  });

  it("says so, and offers no button, in a browser that cannot record", () => {
    media.uninstall();
    mount();
    expect(
      screen.getByText(/isn't available in this browser/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("uses native buttons that never submit a form", () => {
    serve();
    mount();
    const button = speak();
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
    expect(button).not.toHaveAttribute("tabindex", "-1");
  });

  it("can be disabled", () => {
    serve();
    mount({ disabled: true });
    expect(speak()).toBeDisabled();
  });
});

describe("a recording", () => {
  it("starts on Speak, ends on Stop, and puts the transcript in the message, once", async () => {
    serve({ text: "Book a flat repair for Tuesday" });
    const { onTranscript } = mount();

    await startRecording();
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("timer")).toHaveTextContent("0:00 of 0:15");
    expect(screen.getByRole("status")).toHaveTextContent(/Recording/);

    await stopRecording();
    await waitFor(() =>
      expect(onTranscript).toHaveBeenCalledWith(
        "Book a flat repair for Tuesday",
      ),
    );
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      /Check it, change it if you like, then press Send transcript/,
    );
    // The transcript is waiting to be checked: Record again replaces Speak.
    expect(screen.queryByRole("button", { name: "Speak" })).toBeNull();
    expect(screen.getByRole("button", { name: "Record again" })).toBeEnabled();
    expect(media.streams.every((stream) => stream.allStopped)).toBe(true);
  });

  it("tells the page while a transcript waits to be checked, and stops when it is cancelled", async () => {
    serve();
    const onReviewChange = vi.fn();
    const control = createRef<VoiceControl>();
    mount({ onReviewChange, controlRef: control });
    await startRecording();
    await stopRecording();
    await screen.findByText(/transcript is in your message/i);
    expect(onReviewChange).toHaveBeenLastCalledWith(true);
    act(() => control.current?.cancel());
    expect(onReviewChange).toHaveBeenLastCalledWith(false);
    expect(speak()).toBeEnabled();
  });

  it("asks whether voice is on before it asks for the microphone", async () => {
    serve();
    mount();
    await startRecording();
    const calls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(calls[0]).toContain("probe=1");
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      media.getUserMedia.mock.invocationCallOrder[0],
    );
  });

  it("asks only once per page when voice is on", async () => {
    serve();
    mount();
    await startRecording();
    await stopRecording();
    await screen.findByText(/transcript is in your message/i);
    await startRecording("Record again");
    expect(
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("probe=1")),
    ).toHaveLength(1);
  });

  it("keeps focus on the same control while it turns from Speak into Stop", async () => {
    serve();
    mount();
    speak().focus();
    const stop = await startRecording();
    expect(stop).toHaveFocus();
  });

  it("is a toggle: pressing and releasing Speak keeps recording until Stop", async () => {
    serve();
    mount();
    const button = speak();
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    await act(async () => {
      fireEvent.click(button);
    });
    const stop = await screen.findByRole("button", { name: "Stop" });
    fireEvent.pointerUp(stop); // nothing about releasing a button ends the recording
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(FakeRecorder.instances[0].state).toBe("recording");
  });

  it("tells the visitor when the 15 second limit ended it", async () => {
    serve();
    const { onTranscript } = mount();
    await startRecording();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await waitFor(() => expect(onTranscript).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(2); // the probe and the transcription
  });

  it("shows the elapsed time while recording", async () => {
    serve();
    mount();
    await startRecording();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_100);
    });
    expect(screen.getByRole("timer")).toHaveTextContent("0:07 of 0:15");
  });

  it("calls back when a new recording starts, so spoken output can stop", async () => {
    serve();
    const onRecordingStart = vi.fn();
    mount({ onRecordingStart });
    await startRecording();
    expect(onRecordingStart).toHaveBeenCalledTimes(1);
  });
});

describe("cancelling", () => {
  it("Cancel recording stops the microphone and sends nothing", async () => {
    serve();
    const { onTranscript } = mount();
    await startRecording();

    await press("Cancel recording");

    expect(media.streams.every((stream) => stream.allStopped)).toBe(true);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.filter((c) => !String(c[0]).includes("probe=1")),
    ).toHaveLength(0); // the audio was never uploaded
    expect(speak()).toBeEnabled();
  });

  it("Cancel while the permission prompt is open abandons it and stops a late stream", async () => {
    media = installMedia({ auto: false });
    serve();
    const { onTranscript } = mount();
    await press("Speak");
    await waitFor(() => expect(media.getUserMedia).toHaveBeenCalled());

    await press("Cancel");
    const late = media.grant(); // the browser answers afterwards
    await act(async () => {});

    expect(late.allStopped).toBe(true);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(speak()).toBeEnabled();
  });

  it("Cancel transcription really aborts the request and ignores any late answer", async () => {
    const { signals } = hang();
    const { onTranscript } = mount();
    await startRecording();
    await stopRecording();
    await screen.findByRole("button", { name: "Cancel transcription" });
    expect(signals[0].aborted).toBe(false);

    await press("Cancel transcription");

    expect(signals[0].aborted).toBe(true);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(speak()).toBeEnabled();
  });

  it("ignores a transcript that arrives after a cancel", async () => {
    let answer: (response: Response) => void = () => undefined;
    serve({
      transcribe: () =>
        new Promise<Response>((resolve) => {
          answer = resolve; // ignores the signal: a late answer must still be dropped
        }),
    });
    const { onTranscript } = mount();
    await startRecording();
    await stopRecording();
    await press("Cancel transcription");

    await act(async () => {
      answer(json({ text: "late words" }));
    });

    expect(onTranscript).not.toHaveBeenCalled();
    expect(screen.queryByText(/transcript is in your message/i)).toBeNull();
  });

  it("a new recording invalidates the one before it", async () => {
    const answers: Array<(response: Response) => void> = [];
    serve({
      transcribe: () =>
        new Promise<Response>((resolve) => {
          answers.push(resolve);
        }),
    });
    const { onTranscript } = mount();
    await startRecording();
    await stopRecording();
    await screen.findByRole("button", { name: "Record again" });

    await press("Record again"); // the first transcription is still pending
    await screen.findByRole("button", { name: "Stop" });
    await stopRecording();
    await waitFor(() => expect(answers).toHaveLength(2));

    await act(async () => {
      answers[1](json({ text: "second recording" }));
    });
    await waitFor(() => expect(onTranscript).toHaveBeenCalledTimes(1));
    await act(async () => {
      answers[0](json({ text: "first recording, now stale" }));
    });

    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("second recording");
  });
});

describe("leaving the page", () => {
  it("releases the microphone when the component unmounts mid-recording", async () => {
    serve();
    const { unmount } = mount();
    await startRecording();
    unmount();
    expect(media.streams.every((stream) => stream.allStopped)).toBe(true);
  });

  it("aborts the request when the component unmounts mid-transcription", async () => {
    const { signals } = hang();
    const { unmount } = mount();
    await startRecording();
    await stopRecording();
    await screen.findByRole("button", { name: "Cancel transcription" });
    unmount();
    expect(signals[0].aborted).toBe(true);
  });

  it("releases everything on pagehide and looks idle afterwards", async () => {
    serve();
    mount();
    await startRecording();
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(media.streams.every((stream) => stream.allStopped)).toBe(true);
    expect(speak()).toBeEnabled();
  });
});

describe("problems keep typing available", () => {
  it("explains a blocked microphone and takes focus", async () => {
    media = installMedia({ auto: false });
    serve();
    mount();
    await press("Speak");
    await waitFor(() => expect(media.getUserMedia).toHaveBeenCalled());
    await act(async () => {
      media.deny("NotAllowedError");
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Microphone access is blocked");
    expect(alert).toHaveTextContent("You can still type your message.");
    expect(alert).toHaveFocus();
    expect(speak()).toBeEnabled();
  });

  it.each([
    ["NotFoundError", "No microphone was found"],
    ["NotReadableError", "The microphone can't be used right now"],
  ])("explains %s", async (name, title) => {
    media = installMedia({ auto: false });
    serve();
    mount();
    await press("Speak");
    await waitFor(() => expect(media.getUserMedia).toHaveBeenCalled());
    await act(async () => {
      media.deny(name);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(title);
  });

  it("gives up on an ignored permission prompt", async () => {
    media = installMedia({ auto: false });
    serve();
    mount();
    await press("Speak");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The microphone prompt wasn't answered",
    );
    const late = media.grant();
    await act(async () => {});
    expect(late.allStopped).toBe(true);
  });

  it("explains a browser that only records formats we cannot use", async () => {
    FakeRecorder.supported = [];
    FakeRecorder.defaultMime = "audio/x-unknown";
    serve();
    mount();
    await press("Speak");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This browser records in a format we can't use",
    );
    expect(media.streams.every((stream) => stream.allStopped)).toBe(true);
  });

  it("does not record when voice is not switched on", async () => {
    serve({ available: false });
    mount();
    await press("Speak");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Voice input isn't switched on",
    );
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });

  it("reports a voice service that cannot be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    mount();
    await press("Speak");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Voice input can't be reached",
    );
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });

  it("explains a recording that was too short", async () => {
    serve();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000); // no time passes between Speak and Stop
    mount();
    await startRecording();
    await press("Stop");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That recording was too short",
    );
  });

  it.each([
    ["no_speech", 422, "No speech was found"],
    ["busy", 429, "Voice input is busy"],
    ["timeout", 504, "Transcription took too long"],
    ["failed", 502, "That didn't work"],
  ])("explains the answer %s", async (code, status, title) => {
    serve({ transcribe: () => Promise.resolve(json({ error: code }, status)) });
    const { onTranscript } = mount();
    await startRecording();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await stopRecording();
    expect(await screen.findByRole("alert")).toHaveTextContent(title);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(speak()).toBeEnabled();
  });
});

describe("privacy", () => {
  it("stores nothing and creates no object URL", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const createObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL }));
    serve();
    const { onTranscript } = mount();
    await startRecording();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await stopRecording();
    await waitFor(() => expect(onTranscript).toHaveBeenCalled());

    expect(setItem).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it("talks only to the same-origin route", async () => {
    serve();
    const { onTranscript } = mount();
    await startRecording();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await stopRecording();
    await waitFor(() => expect(onTranscript).toHaveBeenCalled());
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toMatch(/^\/api\/voice\/transcribe/);
    }
  });

  it("never writes audio or text to the console", async () => {
    const spies = ["log", "info", "warn", "error", "debug"].map((name) =>
      vi.spyOn(console, name as "log"),
    );
    serve();
    const { onTranscript } = mount();
    await startRecording();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await stopRecording();
    await waitFor(() => expect(onTranscript).toHaveBeenCalled());
    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });
});

describe("accessibility", () => {
  it("has no axe violations at rest, while recording and after an error", async () => {
    serve();
    const rest = mount();
    await expectNoA11yViolations(rest.container);
    rest.unmount();

    const recording = mount();
    await startRecording();
    await expectNoA11yViolations(recording.container);
    recording.unmount();

    serve({ available: false });
    const failed = mount();
    await press("Speak");
    await screen.findByRole("alert");
    await expectNoA11yViolations(failed.container);
  });

  it("announces state changes politely and keeps the timer out of the live region", async () => {
    serve();
    mount();
    await startRecording();
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("timer")).toHaveAttribute("aria-live", "off");
    expect(status).not.toContainElement(screen.getByRole("timer"));
  });

  it("animates only for people who have not asked for reduced motion", async () => {
    serve();
    const { container } = mount();
    await startRecording();
    const classes = Array.from(container.querySelectorAll("[class]")).map(
      (element) => element.getAttribute("class") ?? "",
    );
    expect(
      classes.some((value) => value.includes("motion-safe:animate-pulse")),
    ).toBe(true);
    expect(classes.some((value) => /(^|\s)animate-/.test(value))).toBe(false);
  });
});

describe("control from outside", () => {
  it("cancel() abandons a transcription in flight, so its text never arrives", async () => {
    const { signals } = hang();
    const controlRef = createRef<VoiceControl>();
    const onTranscript = vi.fn();
    render(<VoiceInput onTranscript={onTranscript} controlRef={controlRef} />);
    await startRecording();
    await stopRecording();
    await screen.findByRole("button", { name: "Cancel transcription" });

    act(() => controlRef.current?.cancel());

    expect(signals[0].aborted).toBe(true);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(speak()).toBeEnabled();
  });

  it("cancel() stops a recording and releases the microphone", async () => {
    serve();
    const controlRef = createRef<VoiceControl>();
    render(<VoiceInput onTranscript={vi.fn()} controlRef={controlRef} />);
    await startRecording();

    act(() => controlRef.current?.cancel());

    expect(media.streams.every((stream) => stream.allStopped)).toBe(true);
    expect(speak()).toBeEnabled();
  });

  it("delivers a transcript to the newest callback, not the one from when it started", async () => {
    serve({ text: "from the late answer" });
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<VoiceInput onTranscript={first} />);
    await startRecording();
    rerender(<VoiceInput onTranscript={second} />);
    await stopRecording();
    await waitFor(() =>
      expect(second).toHaveBeenCalledWith("from the late answer"),
    );
    expect(first).not.toHaveBeenCalled();
  });
});

describe("under React StrictMode", () => {
  it("still records, transcribes and releases the microphone", async () => {
    serve({ text: "strict mode words" });
    const onTranscript = vi.fn();
    render(
      <StrictMode>
        <VoiceInput onTranscript={onTranscript} />
      </StrictMode>,
    );
    await startRecording();
    await stopRecording();
    await waitFor(() =>
      expect(onTranscript).toHaveBeenCalledWith("strict mode words"),
    );
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(media.streams.every((stream) => stream.allStopped)).toBe(true);
  });
});
