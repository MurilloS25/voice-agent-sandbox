"use client";

import {
  useEffect,
  useImperativeHandle,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";

import type { Turn } from "@/app/assistant/state";
import { MAX_MESSAGE_LENGTH } from "@/lib/agent-message";
import { MAX_RECORDING_MS } from "@/lib/voice/limits";
import { STAGE_COPY, type StageKind } from "@/lib/voice/stage";
import { formatClock, useVoiceCapture } from "@/lib/voice/use-voice-capture";
import { deniedCopy, problemCopy, VOICE_WORDING } from "@/lib/voice/voice-copy";

import { Orb } from "./Orb";
import type { VoiceControl } from "./VoiceInput";

const primaryClass =
  "inline-flex min-h-12 items-center justify-center rounded-full bg-bottle px-7 py-2 text-lg font-bold [overflow-wrap:anywhere] text-cream shadow-sm hover:bg-moss disabled:opacity-60";
const secondaryClass =
  "inline-flex min-h-12 items-center justify-center rounded-full border border-bottle/40 bg-white px-5 py-2 font-bold [overflow-wrap:anywhere] hover:bg-celeste/40 disabled:opacity-60";
const quietClass =
  "inline-flex min-h-12 items-center justify-center px-3 py-2 font-bold underline underline-offset-4 [overflow-wrap:anywhere]";

const subscribeNothing = () => () => undefined;

type VoiceStageProps = {
  /** The visitor started the voice session. Until then only Start is offered. */
  sessionActive: boolean;
  /** Runs inside the click, so the welcome can be spoken from the visitor's own gesture. */
  onStart: () => void;
  onEnd: () => void;
  /** The assistant is working on a message ("thinking") or reading a reply ("speaking"). */
  busy: "thinking" | "speaking" | null;
  onStopSpeaking: () => void;
  /** The text under review and where it lives (the conversation's message box). */
  draft: string;
  onDraft: (text: string) => void;
  /** A transcript has been handed over and is waiting for the visitor's decision. */
  transcriptPending: boolean;
  onTranscript: (text: string) => void;
  onRecordingStart: () => void;
  onSend: () => void;
  onCancelTranscript: () => void;
  controlRef: Ref<VoiceControl>;
  /** The welcome, the latest exchange and the reply that is being waited for. */
  welcome: ReactNode;
  lastTurn: Turn | null;
  sendingMessage: string | null;
  /** A reply that could not be read aloud, and what to say about speech. */
  unheard: boolean;
  onReadAloud: () => void;
  speechAvailable: boolean;
  speechNote: ReactNode;
  /** A problem with the turn itself (the notice component supplies its own buttons). */
  problem: ReactNode;
  /** The live booking review, when there is one. */
  review: ReactNode;
  onSwitchToText: () => void;
  /** Placed after the stage, for example the voice settings link. */
  footer?: ReactNode;
};

/**
 * The voice mode: one big control in the middle, the state in words, and only the controls that
 * make sense in that state. The recording flow is the same hook the text composer uses; the stage
 * is derived from it, from the turn in flight and from the speech controller, never from a timer.
 */
export function VoiceStage({
  sessionActive,
  onStart,
  onEnd,
  busy,
  onStopSpeaking,
  draft,
  onDraft,
  transcriptPending,
  onTranscript,
  onRecordingStart,
  onSend,
  onCancelTranscript,
  controlRef,
  welcome,
  lastTurn,
  sendingMessage,
  unheard,
  onReadAloud,
  speechAvailable,
  speechNote,
  problem,
  review,
  onSwitchToText,
  footer,
}: VoiceStageProps) {
  const capture = useVoiceCapture({ onTranscript, onRecordingStart });
  const hydrated = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  const alertRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLButtonElement>(null);
  const previousStage = useRef<StageKind | null>(null);
  const heardRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(controlRef, () => ({ cancel: capture.cancel }), [
    capture.cancel,
  ]);

  const captureProblem =
    capture.state.kind === "denied" || capture.state.kind === "error";

  let stage: StageKind;
  if (!sessionActive) stage = "start";
  else if (busy === "thinking") stage = "thinking";
  else if (busy === "speaking") stage = "speaking";
  else if (capture.state.kind === "requesting_permission") stage = "preparing";
  else if (capture.state.kind === "recording") stage = "listening";
  else if (capture.state.kind === "transcribing") stage = "transcribing";
  else if (transcriptPending) stage = "review";
  else if (problem || captureProblem) stage = "error";
  else stage = "ready";

  // The transcript takes focus when it arrives, with the cursor at its end, ready to edit.
  const arrived = stage === "review" && capture.state.kind === "review";
  useEffect(() => {
    if (!arrived) return;
    const box = heardRef.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [arrived]);

  // A problem takes focus so a screen reader hears it.
  useEffect(() => {
    if (captureProblem) alertRef.current?.focus();
  }, [captureProblem]);

  // Leaving the review (sent or cancelled) removes the text box that had focus: the one main
  // control takes it, so a keyboard user is never dropped at the top of the page.
  useEffect(() => {
    if (previousStage.current === "review" && stage !== "review") {
      orbRef.current?.focus();
    }
    previousStage.current = stage;
  }, [stage]);

  const copy = STAGE_COPY[stage];
  const unsupported = hydrated && !capture.supported;

  function primary() {
    switch (stage) {
      case "start":
        onStart();
        break;
      case "ready":
      case "error":
        capture.start();
        break;
      case "preparing":
      case "transcribing":
        capture.cancel();
        break;
      case "listening":
        capture.stop();
        break;
      case "speaking":
        onStopSpeaking();
        break;
      default:
        break; // thinking: nothing to do but wait
    }
  }

  function onHeardKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      onSend();
    }
  }

  const labelText =
    stage === "error" && problem ? "The assistant needs a moment" : copy.label;

  if (unsupported) {
    return (
      <section
        aria-labelledby="voice-heading"
        className="relative h-full min-h-0 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-4 py-10 text-center">
          <h2
            id="voice-heading"
            className="font-display text-3xl font-extrabold"
          >
            Voice isn&apos;t available here
          </h2>
          <p>
            This browser can&apos;t record from a microphone, so the voice
            assistant can&apos;t listen. Text mode has the same assistant, the
            same conversation and the same booking confirmation.
          </p>
          <button
            type="button"
            onClick={onSwitchToText}
            className={primaryClass}
          >
            Switch to Text
          </button>
        </div>
      </section>
    );
  }

  const actionDisabled = stage === "thinking";
  const showOrbButton = stage !== "review";

  return (
    <section
      aria-labelledby="voice-heading"
      className="relative h-full min-h-0 overflow-y-auto"
    >
      <h2 id="voice-heading" className="sr-only">
        Voice assistant
      </h2>
      <div
        className={`mx-auto grid w-full max-w-6xl gap-x-10 gap-y-4 px-4 py-2 sm:px-8 sm:py-4 ${
          review
            ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,min(28rem,45%))] lg:grid-rows-[auto_1fr] lg:items-start"
            : ""
        }`}
      >
        <div className="mx-auto flex w-full max-w-xl min-w-0 flex-col items-center gap-3 text-center sm:gap-4 lg:col-start-1">
          <p
            role="status"
            aria-live="polite"
            className="font-display text-3xl leading-none font-extrabold [overflow-wrap:anywhere] sm:text-4xl"
          >
            {labelText}
          </p>
          {stage === "listening" ? (
            <p className="font-bold" role="timer" aria-live="off">
              {formatClock(capture.elapsedMs)} of{" "}
              {formatClock(MAX_RECORDING_MS)}
            </p>
          ) : null}
          {showOrbButton ? (
            <button
              ref={orbRef}
              type="button"
              onClick={actionDisabled ? undefined : primary}
              aria-disabled={actionDisabled || undefined}
              className="group flex min-h-12 flex-col items-center gap-3 rounded-[2rem] p-2"
            >
              <Orb
                stage={stage}
                small={review !== null && review !== undefined}
              />
              <span
                className={primaryClass + " group-aria-disabled:opacity-60"}
              >
                {copy.action}
              </span>
            </button>
          ) : (
            <span className="[@media(max-height:40rem)]:hidden">
              <Orb stage="review" small />
            </span>
          )}

          {stage === "listening" ? (
            <button
              type="button"
              onClick={capture.cancel}
              className={secondaryClass}
            >
              Cancel recording
            </button>
          ) : null}

          {copy.hint && stage !== "review" && !review ? (
            <p className="max-w-md text-sm">
              {stage === "transcribing" &&
              capture.state.kind === "transcribing" &&
              capture.state.autoStopped
                ? "Recording stopped after 15 seconds. Turning it into text."
                : copy.hint}
            </p>
          ) : null}

          {stage === "review" ? (
            <div className="w-full space-y-3 text-left">
              {capture.state.kind === "denied" ? (
                <div
                  ref={alertRef}
                  role="alert"
                  tabIndex={-1}
                  className="rounded-2xl border-l-8 border-rust bg-white p-3"
                >
                  <p className="font-bold text-rust">
                    {deniedCopy(VOICE_WORDING).title}
                  </p>
                  <p>{deniedCopy(VOICE_WORDING).body}</p>
                  <p className="text-sm">What I heard before is kept below.</p>
                </div>
              ) : null}
              {capture.state.kind === "error" ? (
                <div
                  ref={alertRef}
                  role="alert"
                  tabIndex={-1}
                  className="rounded-2xl border-l-8 border-rust bg-white p-3"
                >
                  <p className="font-bold text-rust">
                    {problemCopy(capture.state.code, VOICE_WORDING).title}
                  </p>
                  <p>{problemCopy(capture.state.code, VOICE_WORDING).body}</p>
                  <p className="text-sm">What I heard before is kept below.</p>
                </div>
              ) : null}
              <div>
                <label htmlFor="heard" className="block font-bold">
                  What I heard (you can edit it)
                </label>
                <textarea
                  id="heard"
                  ref={heardRef}
                  rows={3}
                  maxLength={MAX_MESSAGE_LENGTH}
                  value={draft}
                  onChange={(event) => onDraft(event.target.value)}
                  onKeyDown={onHeardKeyDown}
                  aria-describedby="heard-help"
                  className="mt-1 block w-full resize-y rounded-2xl border border-bottle/40 bg-white px-4 py-3 text-lg"
                />
                <p id="heard-help" className="mt-1 text-sm">
                  {draft.length} of {MAX_MESSAGE_LENGTH} characters. Enter
                  sends. Please don&apos;t say personal details.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={onSend}
                  disabled={draft.trim() === ""}
                  className={primaryClass}
                >
                  Send what I said
                </button>
                <button
                  type="button"
                  onClick={capture.start}
                  className={secondaryClass}
                >
                  Record again
                </button>
                <button
                  type="button"
                  onClick={() => {
                    capture.cancel();
                    onCancelTranscript();
                  }}
                  className={secondaryClass}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {stage === "error" && captureProblem ? (
            <div
              ref={alertRef}
              role="alert"
              tabIndex={-1}
              className="w-full rounded-2xl border-l-8 border-rust bg-white p-3 text-left"
            >
              <p className="font-bold text-rust">
                {capture.state.kind === "denied"
                  ? deniedCopy(VOICE_WORDING).title
                  : capture.state.kind === "error"
                    ? problemCopy(capture.state.code, VOICE_WORDING).title
                    : ""}
              </p>
              <p>
                {capture.state.kind === "denied"
                  ? deniedCopy(VOICE_WORDING).body
                  : capture.state.kind === "error"
                    ? problemCopy(capture.state.code, VOICE_WORDING).body
                    : ""}
              </p>
            </div>
          ) : null}

          {problem ? <div className="w-full text-left">{problem}</div> : null}

          {sessionActive && !speechAvailable ? (
            <p className="max-w-md text-sm font-bold">
              This browser can&apos;t read replies aloud, so they appear here as
              text.
            </p>
          ) : null}
          {speechNote ? (
            <div className="w-full text-left">{speechNote}</div>
          ) : null}
          {unheard ? (
            <button
              type="button"
              onClick={onReadAloud}
              className={secondaryClass}
            >
              Read reply aloud
            </button>
          ) : null}
        </div>

        {review ? (
          <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            {review}
          </div>
        ) : null}

        <div className="mx-auto flex w-full max-w-xl min-w-0 flex-col items-center gap-3 text-center sm:gap-4 lg:col-start-1">
          {stage === "review" ? null : sendingMessage !== null || lastTurn ? (
            <section
              aria-label="Latest exchange"
              className="w-full space-y-3 rounded-2xl bg-white p-4 text-left shadow-[0_2px_14px_-6px_rgb(15_59_54/0.35)]"
            >
              {sendingMessage !== null ? (
                <p className="[overflow-wrap:anywhere] whitespace-pre-wrap">
                  <span className="font-bold">You said: </span>
                  {sendingMessage}
                </p>
              ) : lastTurn ? (
                <>
                  <p className="[overflow-wrap:anywhere] whitespace-pre-wrap">
                    <span className="font-bold">You said: </span>
                    {lastTurn.message}
                  </p>
                  <p className="[overflow-wrap:anywhere] whitespace-pre-wrap">
                    <span className="font-bold">
                      {lastTurn.response.reply.source === "assistant"
                        ? "Assistant (AI): "
                        : "System: "}
                    </span>
                    {lastTurn.response.reply.text}
                  </p>
                </>
              ) : null}
            </section>
          ) : (
            welcome
          )}

          <div className="flex flex-wrap items-center justify-center gap-x-4">
            {sessionActive ? (
              <button type="button" onClick={onEnd} className={quietClass}>
                End voice session
              </button>
            ) : null}
            <button
              type="button"
              onClick={onSwitchToText}
              className={quietClass}
            >
              Switch to Text
            </button>
            {footer}
          </div>
        </div>
      </div>
    </section>
  );
}
