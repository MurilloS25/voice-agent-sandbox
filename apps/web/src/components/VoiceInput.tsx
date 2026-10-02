"use client";

import {
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
  type Ref,
} from "react";

import { MAX_RECORDING_MS } from "@/lib/voice/limits";
import { formatClock, useVoiceCapture } from "@/lib/voice/use-voice-capture";
import { deniedCopy, problemCopy, TEXT_WORDING } from "@/lib/voice/voice-copy";

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

/** What the page can ask of the voice control from outside (for example when a message is sent). */
export type VoiceControl = { cancel: () => void };

type VoiceInputProps = {
  /** The transcript, to be placed in the message box. It is never sent from here. */
  onTranscript: (text: string) => void;
  /** Called when a new recording is requested (for example to stop spoken output). */
  onRecordingStart?: () => void;
  /** True while a transcript is in the box waiting for the visitor to check and send it. */
  onReviewChange?: (reviewing: boolean) => void;
  /** The page's own send button, placed at the end of the controls row. */
  actions?: ReactNode;
  disabled?: boolean;
  controlRef?: Ref<VoiceControl>;
};

export function VoiceInput({
  onTranscript,
  onRecordingStart,
  onReviewChange,
  actions,
  disabled = false,
  controlRef,
}: VoiceInputProps) {
  const { supported, state, elapsedMs, start, stop, cancel } = useVoiceCapture({
    onTranscript,
    onRecordingStart,
  });
  const alertRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(controlRef, () => ({ cancel }), [cancel]);

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
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 basis-56 text-sm">
          Voice input isn&apos;t available in this browser. You can type your
          message.
        </p>
        {actions}
      </div>
    );
  }

  return (
    <div role="group" aria-label="Voice input" className="mt-3 space-y-2">
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
            onClick={start}
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
            onClick={start}
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
            onClick={start}
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
              {formatClock(elapsedMs)} of {formatClock(MAX_RECORDING_MS)}
            </span>
          </p>
        ) : null}

        {actions ? <div className="ml-auto">{actions}</div> : null}
      </div>

      {state.kind === "denied" ? (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="border-l-8 border-rust bg-white/60 p-3"
        >
          <p className="font-bold text-rust">
            {deniedCopy(TEXT_WORDING).title}
          </p>
          <p>{deniedCopy(TEXT_WORDING).body}</p>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="border-l-8 border-rust bg-white/60 p-3"
        >
          <p className="font-bold text-rust">
            {problemCopy(state.code, TEXT_WORDING).title}
          </p>
          <p>{problemCopy(state.code, TEXT_WORDING).body}</p>
        </div>
      ) : null}

      <p id="voice-help" className="text-sm">
        Speak sends a recording of up to 15 seconds to a transcription service
        to turn it into text. This app doesn&apos;t store it, and you check the
        text before you send it.
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
