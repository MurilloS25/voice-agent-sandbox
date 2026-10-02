"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  CaptureError,
  isCaptureSupported,
  startCapture,
  type Capture,
  type CaptureErrorCode,
} from "./capture";
import { MAX_RECORDING_MS } from "./limits";
import type { CaptureProblem } from "./voice-copy";
import { transcribeClip, probeVoice } from "./transcribe";

export type CaptureState =
  | { kind: "idle" }
  | { kind: "requesting_permission" }
  | { kind: "recording" }
  | { kind: "transcribing"; autoStopped: boolean }
  | { kind: "review" } // the transcript has been handed over and waits to be checked
  | { kind: "denied" }
  | { kind: "unsupported" }
  | { kind: "error"; code: CaptureProblem };

const subscribeNothing = () => () => undefined;

/** "0:07" for a length in milliseconds, never beyond the recording limit. */
export function formatClock(ms: number): string {
  const seconds = Math.floor(Math.min(ms, MAX_RECORDING_MS) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

type Options = {
  /** The transcript. It is never sent from here. */
  onTranscript: (text: string) => void;
  /** Called when a new recording is requested (for example to stop spoken output). */
  onRecordingStart?: () => void;
};

export type VoiceCapture = {
  /** False while rendering on the server and during hydration, then the real answer. */
  supported: boolean;
  state: CaptureState;
  elapsedMs: number;
  /** Starts a recording (asks for the microphone only now, after a press). */
  start: () => void;
  /** Ends the recording and sends it to be transcribed. */
  stop: () => void;
  /** Abandons whatever is in flight and goes back to idle. */
  cancel: () => void;
};

/**
 * One push-to-talk recording at a time: the microphone, the transcription request and the state
 * that goes with them. It holds no audio after the request ends and stores nothing. Both the
 * text composer and the voice stage use it, each with its own markup.
 */
export function useVoiceCapture({
  onTranscript,
  onRecordingStart,
}: Options): VoiceCapture {
  const supported = useSyncExternalStore(
    subscribeNothing,
    isCaptureSupported,
    () => false,
  );
  const [state, setState] = useState<CaptureState>({ kind: "idle" });
  const [elapsedMs, setElapsedMs] = useState(0);

  // A new run invalidates the one before it.
  const run = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const capture = useRef<Capture | null>(null);
  const voiceOn = useRef(false); // a probe already said the service is switched on
  const startedAt = useRef(0);
  // The newest callbacks, so a recording that started earlier still reaches the latest ones.
  const latestTranscript = useRef(onTranscript);
  const latestStart = useRef(onRecordingStart);
  useEffect(() => {
    latestTranscript.current = onTranscript;
    latestStart.current = onRecordingStart;
  });

  /** Invalidates whatever is in flight: stops the microphone and aborts the request. */
  const discard = useCallback(() => {
    run.current += 1;
    controller.current?.abort();
    controller.current = null;
    capture.current?.cancel();
    capture.current = null;
  }, []);

  const cancel = useCallback(() => {
    discard();
    setState({ kind: "idle" });
  }, [discard]);

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

  function fromCapture(error: unknown): CaptureState {
    const code: CaptureErrorCode =
      error instanceof CaptureError ? error.code : "failed";
    if (code === "permission_denied") return { kind: "denied" };
    if (code === "unsupported") return { kind: "unsupported" };
    if (code === "cancelled") return { kind: "idle" };
    return { kind: "error", code };
  }

  async function begin() {
    discard();
    const id = run.current;
    const abort = new AbortController();
    controller.current = abort;
    latestStart.current?.();
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

  return {
    supported,
    state,
    elapsedMs,
    start: () => void begin(),
    stop: () => capture.current?.stop(),
    cancel,
  };
}
