"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";

import {
  CaptureError,
  isCaptureSupported,
  startCapture,
  type Capture,
  type CaptureErrorCode,
} from "@/lib/voice/capture";
import { MAX_RECORDING_MS, type VoiceErrorCode } from "@/lib/voice/limits";
import { probeVoice, transcribeClip } from "@/lib/voice/transcribe";

/** Everything that can go wrong after the first press, except a denied permission. */
type ErrorCode =
  | Exclude<CaptureErrorCode, "permission_denied" | "unsupported" | "cancelled">
  | VoiceErrorCode;

type State =
  | { kind: "idle" }
  | { kind: "requesting_permission" }
  | { kind: "recording" }
  | { kind: "transcribing"; autoStopped: boolean }
  | { kind: "review" } // the transcript is in the message box
  | { kind: "denied" }
  | { kind: "unsupported" }
  | { kind: "error"; code: ErrorCode };

const TYPE_INSTEAD = "You can still type your message.";

const ERROR_COPY: Record<ErrorCode, { title: string; body: string }> = {
  permission_timeout: {
    title: "The microphone prompt wasn't answered",
    body: `Press Speak to try again. ${TYPE_INSTEAD}`,
  },
  no_device: {
    title: "No microphone was found",
    body: `Connect one and press Speak again. ${TYPE_INSTEAD}`,
  },
  device_busy: {
    title: "The microphone can't be used right now",
    body: `Another app may be using it. ${TYPE_INSTEAD}`,
  },
  format_unsupported: {
    title: "This browser records in a format we can't use",
    body: TYPE_INSTEAD,
  },
  too_short: {
    title: "That recording was too short",
    body: `Press Speak, say your message, then press Stop. ${TYPE_INSTEAD}`,
  },
  too_large: {
    title: "That recording was too large",
    body: `Try a shorter message. ${TYPE_INSTEAD}`,
  },
  failed: {
    title: "That didn't work",
    body: `The recording could not be turned into text. ${TYPE_INSTEAD}`,
  },
  feature_off: {
    title: "Voice input isn't switched on",
    body: `This demo has no transcription service connected. ${TYPE_INSTEAD}`,
  },
  unsupported: {
    title: "That recording format isn't accepted",
    body: TYPE_INSTEAD,
  },
  invalid: {
    title: "The recording couldn't be read",
    body: `Try recording again. ${TYPE_INSTEAD}`,
  },
  no_speech: {
    title: "No speech was found",
    body: `Try again, closer to the microphone. ${TYPE_INSTEAD}`,
  },
  busy: {
    title: "Voice input is busy",
    body: `Wait a moment and try again. ${TYPE_INSTEAD}`,
  },
  timeout: {
    title: "Transcription took too long",
    body: `Try again with a shorter message. ${TYPE_INSTEAD}`,
  },
  unreachable: {
    title: "Voice input can't be reached",
    body: TYPE_INSTEAD,
  },
  forbidden: {
    title: "Voice input was refused",
    body: TYPE_INSTEAD,
  },
};

const buttonClass =
  "inline-flex min-h-12 items-center gap-2 bg-bottle px-5 py-2 text-lg font-bold [overflow-wrap:anywhere] text-primer hover:bg-moss disabled:opacity-60";
const secondaryClass =
  "inline-flex min-h-12 items-center gap-2 border-2 border-bottle bg-white px-4 py-2 font-bold [overflow-wrap:anywhere] hover:bg-hivis disabled:opacity-60";

function MicIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      className="h-5 w-5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
    </svg>
  );
}

function clock(ms: number): string {
  const seconds = Math.floor(Math.min(ms, MAX_RECORDING_MS) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const subscribeNothing = () => () => undefined;

/** What the page can ask of the voice control from outside (for example when a message is sent). */
export type VoiceControl = { cancel: () => void };

type VoiceInputProps = {
  /** The transcript, to be placed in the message box. It is never sent from here. */
  onTranscript: (text: string) => void;
  /** Called when a new recording is requested (for example to stop spoken output). */
  onRecordingStart?: () => void;
  /** True while a transcript is in the box waiting for the visitor to check and send it. */
  onReviewChange?: (reviewing: boolean) => void;
  disabled?: boolean;
  controlRef?: Ref<VoiceControl>;
};

export function VoiceInput({
  onTranscript,
  onRecordingStart,
  onReviewChange,
  disabled = false,
  controlRef,
}: VoiceInputProps) {
  // False while rendering on the server and during hydration, then the real answer.
  const supported = useSyncExternalStore(
    subscribeNothing,
    isCaptureSupported,
    () => false,
  );
  const [state, setState] = useState<State>({ kind: "idle" });
  const [elapsedMs, setElapsedMs] = useState(0);

  // One recording or transcription at a time: a new run invalidates the one before it.
  const run = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const capture = useRef<Capture | null>(null);
  const voiceOn = useRef(false); // a probe already said the service is switched on
  const startedAt = useRef(0);
  const alertRef = useRef<HTMLDivElement>(null);
  // The newest callback, so a recording that started earlier still reaches the latest message box.
  const latestTranscript = useRef(onTranscript);
  useEffect(() => {
    latestTranscript.current = onTranscript;
  });

  /** Invalidates whatever is in flight: stops the microphone and aborts the request. */
  const discard = useCallback(() => {
    run.current += 1;
    controller.current?.abort();
    controller.current = null;
    capture.current?.cancel();
    capture.current = null;
  }, []);

  /** Invalidates everything in flight and looks idle again. */
  const reset = useCallback(() => {
    discard();
    setState({ kind: "idle" });
  }, [discard]);
  useImperativeHandle(controlRef, () => ({ cancel: reset }), [reset]);

  // Leaving the page, or the component, always releases the microphone and the request.
  useEffect(() => {
    const onHide = () => {
      discard();
      setState({ kind: "idle" }); // a page restored from the cache must not look busy
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      discard();
    };
  }, [discard]);

  useEffect(() => {
    if (state.kind !== "recording") return;
    const timer = setInterval(
      () => setElapsedMs(Date.now() - startedAt.current),
      250,
    );
    return () => clearInterval(timer);
  }, [state.kind]);

  // The composer relabels its send button while a transcript waits to be checked.
  const reviewing = state.kind === "review";
  const latestReview = useRef(onReviewChange);
  useEffect(() => {
    latestReview.current = onReviewChange;
  });
  useEffect(() => {
    latestReview.current?.(reviewing);
  }, [reviewing]);

  // A problem takes focus so a screen reader hears it.
  useEffect(() => {
    if (state.kind === "denied" || state.kind === "error") {
      alertRef.current?.focus();
    }
  }, [state]);

  function fromCapture(error: unknown): State {
    const code: CaptureErrorCode =
      error instanceof CaptureError ? error.code : "failed";
    if (code === "permission_denied") return { kind: "denied" };
    if (code === "unsupported") return { kind: "unsupported" };
    if (code === "cancelled") return { kind: "idle" };
    return { kind: "error", code };
  }

  async function start() {
    discard();
    const id = run.current;
    const abort = new AbortController();
    controller.current = abort;
    onRecordingStart?.();
    setState({ kind: "requesting_permission" });

    // Ask whether voice is switched on before the microphone prompt, so nobody records for
    // nothing. The microphone itself is requested only after this press.
    if (!voiceOn.current) {
      const probe = await probeVoice(abort.signal);
      if (run.current !== id || probe === "aborted") return;
      if (probe !== "on") {
        setState({
          kind: "error",
          code: probe === "off" ? "feature_off" : "unreachable",
        });
        return;
      }
      voiceOn.current = true;
    }

    let active: Capture;
    try {
      active = await startCapture({ signal: abort.signal });
    } catch (error) {
      if (run.current === id) setState(fromCapture(error));
      return;
    }
    if (run.current !== id) {
      active.cancel(); // abandoned while the prompt was open
      return;
    }
    capture.current = active;
    startedAt.current = Date.now();
    setElapsedMs(0);
    setState({ kind: "recording" });

    let clip: Blob | null;
    let autoStopped: boolean;
    try {
      const recording = await active.result;
      clip = recording.blob;
      autoStopped = recording.autoStopped;
    } catch (error) {
      if (run.current === id) {
        capture.current = null;
        setState(fromCapture(error));
      }
      return;
    }
    if (run.current !== id) return;
    capture.current = null;
    setState({ kind: "transcribing", autoStopped });

    const result = await transcribeClip(clip, abort.signal);
    clip = null; // the audio is released as soon as the request is over
    if (run.current !== id) return; // a newer recording, a cancel or a page change won
    controller.current = null;
    if (result.kind === "ok") {
      latestTranscript.current(result.text);
      setState({ kind: "review" });
    } else if (result.kind === "error") {
      setState({ kind: "error", code: result.code });
    } else {
      setState({ kind: "idle" });
    }
  }

  function cancel() {
    reset();
  }

  function stop() {
    capture.current?.stop();
  }

  const recording = state.kind === "recording";
  const requesting = state.kind === "requesting_permission";
  const transcribing = state.kind === "transcribing";

  const status = (() => {
    switch (state.kind) {
      case "requesting_permission":
        return "Getting the microphone ready. Allow it if your browser asks.";
      case "recording":
        return "Recording. Press Stop when you are done. It stops by itself after 15 seconds.";
      case "transcribing":
        return state.autoStopped
          ? "Recording stopped after 15 seconds. Transcribing it."
          : "Transcribing your recording.";
      case "review":
        return "The transcript is in your message. Check it, change it if you like, then press Send transcript.";
      default:
        return "";
    }
  })();

  if (!supported || state.kind === "unsupported") {
    return (
      <p className="mt-3 max-w-prose text-sm">
        Voice input isn&apos;t available in this browser. You can type your
        message.
      </p>
    );
  }

  return (
    <div
      role="group"
      aria-label="Voice input"
      className="min-w-0 flex-1 basis-64 space-y-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        {recording ? (
          <button type="button" onClick={stop} className={buttonClass}>
            Stop
          </button>
        ) : requesting ? (
          <button type="button" onClick={cancel} className={buttonClass}>
            Cancel
          </button>
        ) : transcribing ? (
          <button type="button" onClick={cancel} className={buttonClass}>
            Cancel transcription
          </button>
        ) : state.kind === "review" ? (
          <button
            type="button"
            onClick={() => void start()}
            disabled={disabled}
            aria-describedby="voice-help"
            className={secondaryClass}
          >
            <MicIcon />
            Record again
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void start()}
            disabled={disabled}
            aria-describedby="voice-help"
            className={buttonClass}
          >
            <MicIcon />
            Speak
          </button>
        )}

        {recording ? (
          <button type="button" onClick={cancel} className={secondaryClass}>
            Cancel recording
          </button>
        ) : null}
        {transcribing ? (
          <button
            type="button"
            onClick={() => void start()}
            disabled={disabled}
            className={secondaryClass}
          >
            Record again
          </button>
        ) : null}

        {recording ? (
          <p className="flex items-center gap-2 border-2 border-rust bg-white px-3 py-1 font-bold">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-3 rounded-full bg-rust motion-safe:animate-pulse"
            />
            <span>Recording</span>
            <span role="timer" aria-live="off">
              {clock(elapsedMs)} of {clock(MAX_RECORDING_MS)}
            </span>
          </p>
        ) : null}
      </div>

      {state.kind === "denied" ? (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="border-l-8 border-rust bg-white/60 p-3"
        >
          <p className="font-bold text-rust">Microphone access is blocked</p>
          <p>
            Allow the microphone for this site in your browser&apos;s settings
            and press Speak again. {TYPE_INSTEAD}
          </p>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="border-l-8 border-rust bg-white/60 p-3"
        >
          <p className="font-bold text-rust">{ERROR_COPY[state.code].title}</p>
          <p>{ERROR_COPY[state.code].body}</p>
        </div>
      ) : null}

      <p id="voice-help" className="text-sm">
        Speak sends one short recording (up to 15 seconds) to a transcription
        service to turn it into text. This app doesn&apos;t store it, and the
        text appears in your message for you to check before you send it.
      </p>

      <p
        role="status"
        aria-live="polite"
        className={status ? "text-sm font-bold" : "sr-only"}
      >
        {status}
      </p>
    </div>
  );
}
