"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";

import { sendTurn } from "@/app/assistant/actions";
import type {
  Conversation,
  EndReason,
  Pending,
  Turn,
  TurnOutcome,
} from "@/app/assistant/state";
import {
  MAX_MESSAGE_LENGTH,
  MAX_TURN_INDEX,
  normalizeMessage,
} from "@/lib/agent-message";
import { newUuid } from "@/lib/uuid";
import { useSpeechOutput } from "@/lib/voice/use-speech-output";

import { AssistantWelcome } from "./AssistantWelcome";
import { ExecutionTimeline } from "./ExecutionTimeline";
import { Transcript } from "./Transcript";
import { SpokenReplies } from "./SpokenReplies";
import { VoiceInput, type VoiceControl } from "./VoiceInput";

type Phase =
  | { kind: "idle"; replied: boolean }
  | { kind: "sending" }
  | { kind: "invalid" } // the message failed the check in the browser
  | { kind: "rejected" } // the API refused the message
  | {
      kind: "retry";
      reason: "unknown" | "in_progress" | "busy";
      retryAfterS: number | null;
      attempt: number;
    }
  | { kind: "unavailable" } // no assistant is configured
  | { kind: "ended"; reason: EndReason };

const END_COPY: Record<EndReason, { title: string; body: string }> = {
  not_found: {
    title: "This conversation can't continue",
    body: "The assistant no longer has it, for example because it was restarted.",
  },
  expired: {
    title: "This conversation expired",
    body: "It was idle for too long.",
  },
  out_of_order: {
    title: "This conversation is out of step",
    body: "The assistant's record of it no longer matches this page.",
  },
  key_reused: {
    title: "That message can't be sent again",
    body: "It no longer matches what the assistant has on record.",
  },
  limit: {
    title: "This conversation is full",
    body: "It reached its length limit.",
  },
};

const RETRY_COPY = {
  unknown: {
    title: "We couldn't tell whether the assistant answered",
    body: "Your message is kept below. Trying again sends the same message. While the assistant still has this conversation, it won't repeat an answer it already gave.",
  },
  in_progress: {
    title: "The assistant is still working on it",
    body: "Wait a moment, then try again with the same message.",
  },
  busy: {
    title: "The assistant is busy",
    body: "Wait a moment, then try again with the same message.",
  },
} as const;

const buttonClass =
  "min-h-12 bg-bottle px-6 py-2 text-lg font-bold [overflow-wrap:anywhere] text-primer hover:bg-moss disabled:opacity-60";
const secondaryButtonClass =
  "min-h-12 border-2 border-bottle bg-white px-4 py-2 font-bold [overflow-wrap:anywhere] hover:bg-hivis";
const linkClass = "font-bold underline underline-offset-4";

function Notice({
  title,
  children,
  noticeRef,
}: {
  title: string;
  children: ReactNode;
  noticeRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={noticeRef}
      role="alert"
      tabIndex={-1}
      className="max-w-prose border-2 border-l-8 border-rust bg-white p-4"
    >
      <p className="text-lg font-bold [overflow-wrap:anywhere] text-rust">
        {title}
      </p>
      <div className="mt-1 space-y-3">{children}</div>
    </div>
  );
}

/** The retry button. For a pause asked for by the API it stays disabled until the time is up. */
function RetryButton({
  retryAfterS,
  onRetry,
}: {
  retryAfterS: number | null;
  onRetry: () => void;
}) {
  const [waiting, setWaiting] = useState(retryAfterS !== null);
  useEffect(() => {
    if (retryAfterS === null) return;
    const timer = setTimeout(() => setWaiting(false), retryAfterS * 1000);
    return () => clearTimeout(timer);
  }, [retryAfterS]);
  return (
    <button
      type="button"
      onClick={onRetry}
      disabled={waiting}
      className={buttonClass}
    >
      {waiting ? "Try again in a moment" : "Try again"}
    </button>
  );
}

export function ChatPanel({ initialDraft = "" }: { initialDraft?: string }) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [earlier, setEarlier] = useState<Conversation[]>([]);
  const [draft, setDraft] = useState(initialDraft);
  // A link that arrives while the page is open (for example "Review again") offers its draft
  // too, but never over something the visitor already typed.
  const [seenDraft, setSeenDraft] = useState(initialDraft);
  if (initialDraft !== seenDraft) {
    setSeenDraft(initialDraft);
    if (draft === "") setDraft(initialDraft);
  }
  const [pending, setPending] = useState<Pending | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle", replied: false });
  const [focusTurn, setFocusTurn] = useState<number | null>(null);
  // Counts transcripts placed in the box, so the box takes focus after each one.
  const [transcripts, setTranscripts] = useState(0);
  // The merged transcript did not fit in 500 characters and its end was cut off.
  const [shortened, setShortened] = useState(false);
  const voice = useRef<VoiceControl>(null);
  // A transcript is in the box and has not been sent yet; and which text it was.
  const [reviewing, setReviewing] = useState(false);
  const lastTranscript = useRef("");

  // Spoken replies. Both choices live in memory only and start off; refs mirror them for the
  // async code that reads them after a turn comes back.
  const { output: speech, snapshot: speechState } = useSpeechOutput();
  const [readAloud, setReadAloud] = useState(false);
  const [networkConsent, setNetworkConsent] = useState(false);
  const [speechNote, setSpeechNote] = useState("");
  const readAloudRef = useRef(false);
  const consentRef = useRef(false);

  const inFlight = useRef(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timelineRef = useRef<HTMLDetailsElement>(null);

  // Leaving the page or the component always stops speaking.
  useEffect(() => {
    const stopSpeaking = () => speech.stop();
    window.addEventListener("pagehide", stopSpeaking);
    return () => {
      window.removeEventListener("pagehide", stopSpeaking);
      speech.stop();
    };
  }, [speech]);

  /** Reads one assistant reply aloud. Only its visible text is passed on, nothing else. */
  function speakReply(id: string, text: string, automatic: boolean) {
    const result = speech.speak(id, text, { allowNetwork: consentRef.current });
    if (result === "needs_consent" && !automatic) {
      setSpeechNote(
        "Only a network voice is available. Agree to it under Synthesized voice first.",
      );
    } else if (result === "started") {
      setSpeechNote("");
    }
    // A refusal (for example an autoplay block) is silent: Listen stays available.
  }

  // The timeline is a side column from lg up and a collapsible section below it.
  useEffect(() => {
    const details = timelineRef.current;
    const query = window.matchMedia?.("(min-width: 1024px)");
    if (!details || !query) return;
    const sync = () => {
      details.open = query.matches;
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // Problems take focus so a screen reader hears them. Nothing takes focus on first render.
  useEffect(() => {
    if (
      phase.kind === "retry" ||
      phase.kind === "unavailable" ||
      phase.kind === "ended" ||
      phase.kind === "rejected" ||
      phase.kind === "invalid"
    ) {
      noticeRef.current?.focus();
    }
  }, [phase]);

  // After a transcript is placed in the box the visitor can edit it: focus it, cursor at the end.
  useEffect(() => {
    if (transcripts === 0) return;
    const box = textareaRef.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [transcripts]);

  /** A quick start fills the box and puts the cursor in it. Nothing is sent. */
  function pickDraft(text: string) {
    setDraft(text);
    setShortened(false);
    setPhase((current) =>
      current.kind === "invalid" ? { kind: "idle", replied: false } : current,
    );
    textareaRef.current?.focus();
  }

  /** Recording again replaces the transcript from last time, if it was left as it was. */
  function onRecordingStart() {
    speech.stop();
    const previous = lastTranscript.current;
    lastTranscript.current = "";
    const current = draft.trim();
    if (previous && current.endsWith(previous)) {
      setDraft(current.slice(0, current.length - previous.length).trim());
    }
  }

  /** The transcript joins what is already typed. It is never sent from here: only Send sends. */
  function addTranscript(text: string) {
    lastTranscript.current = text.trim();
    const merged = [draft.trim(), text.trim()]
      .filter((part) => part.length > 0)
      .join(" ");
    setDraft(merged.slice(0, MAX_MESSAGE_LENGTH));
    setShortened(merged.length > MAX_MESSAGE_LENGTH); // typed text is kept; the end is cut
    setPhase((current) =>
      current.kind === "invalid" ? { kind: "idle", replied: false } : current,
    );
    setTranscripts((count) => count + 1);
  }

  async function run(submission: Pending) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase({ kind: "sending" });
    setFocusTurn(null);
    let outcome: TurnOutcome;
    try {
      outcome = await sendTurn(submission);
    } catch {
      // The request itself failed: the outcome is unknown, so the same message is retried.
      outcome = { kind: "retry", reason: "unknown", retryAfterS: null };
    }
    inFlight.current = false;

    switch (outcome.kind) {
      case "ok":
        setTurns((previous) => [
          ...previous,
          { message: submission.message, response: outcome.turn },
        ]);
        setPending(null);
        setDraft("");
        setShortened(false);
        setPhase({ kind: "idle", replied: true });
        setFocusTurn(outcome.turn.turn_index);
        // Only after the visitor turned it on, and only for an assistant reply.
        if (readAloudRef.current && outcome.turn.reply.source === "assistant") {
          speakReply(
            `current-${outcome.turn.turn_index}`,
            outcome.turn.reply.text,
            true,
          );
        }
        break;
      case "retry":
        setPending(submission);
        setPhase((current) => ({
          kind: "retry",
          reason: outcome.reason,
          retryAfterS: outcome.retryAfterS,
          attempt: current.kind === "retry" ? current.attempt + 1 : 1,
        }));
        break;
      case "agent_unavailable":
        setPending(null);
        setPhase({ kind: "unavailable" });
        break;
      case "ended":
        setPending(submission);
        setPhase({ kind: "ended", reason: outcome.reason });
        break;
      case "rejected":
        setPending(null);
        setPhase({ kind: "rejected" });
        break;
    }
  }

  function submit(afterUnavailable = false) {
    if (inFlight.current || pending) return;
    if (phase.kind === "ended") return;
    if (phase.kind === "unavailable" && !afterUnavailable) return;
    if (turns.length >= MAX_TURN_INDEX) {
      // The API ends a conversation after 30 turns; say so instead of sending turn 31.
      setPhase({ kind: "ended", reason: "limit" });
      return;
    }
    const message = normalizeMessage(draft);
    if (message === undefined) {
      setPhase({ kind: "invalid" });
      return;
    }
    // Sending ends any recording or transcription that is still going: its text would arrive
    // after the box was cleared.
    voice.current?.cancel();
    lastTranscript.current = "";
    speech.stop(); // a new turn silences the previous reply
    // The conversation id is made once, on the first submission, and then kept.
    const id = conversationId ?? newUuid();
    if (conversationId === null) setConversationId(id);
    const submission: Pending = {
      conversationId: id,
      clientTurnId: newUuid(),
      turnIndex: turns.length + 1,
      message,
    };
    setPending(submission);
    void run(submission);
  }

  /** Sends the message that is still in the box, once more, after "not switched on". */
  function tryAgain() {
    submit(true);
  }

  function retry() {
    if (pending) void run(pending);
  }

  function startNewConversation() {
    voice.current?.cancel();
    speech.stop();
    if (turns.length > 0 || pending) {
      setEarlier((previous) => [
        ...previous,
        { turns, unsent: pending ? pending.message : null },
      ]);
    }
    setConversationId(null);
    setTurns([]);
    setPending(null);
    // A message that was never sent (the conversation was already full) is kept for the new one.
    if (pending || phase.kind !== "ended") setDraft("");
    setFocusTurn(null);
    setPhase({ kind: "idle", replied: false });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter adds a line; Enter while composing text (IME) does neither.
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  }

  const transcriptReady = reviewing && draft.trim() !== "";
  const ended = phase.kind === "ended";
  const sending = phase.kind === "sending";
  const showComposer =
    phase.kind === "idle" ||
    phase.kind === "sending" ||
    phase.kind === "invalid" ||
    phase.kind === "rejected" ||
    phase.kind === "unavailable";
  const liveReviewTurn = ended
    ? null
    : ([...turns].reverse().find((t) => t.response.booking_review)?.response
        .turn_index ?? null);
  const unsent =
    pending && !sending && phase.kind !== "idle" ? pending.message : null;
  const showSending = sending && pending ? pending.message : null;

  const status =
    phase.kind === "sending"
      ? "Sending your message."
      : phase.kind === "idle" && phase.replied
        ? "The assistant replied."
        : "";

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] lg:items-start lg:gap-10">
      <section
        aria-labelledby="chat-heading"
        className="min-w-0 border-2 border-bottle bg-white/70"
      >
        <h2 id="chat-heading" className="sr-only">
          Conversation
        </h2>

        <SpokenReplies
          snapshot={speechState}
          readAloud={readAloud}
          onReadAloud={(on) => {
            readAloudRef.current = on;
            setReadAloud(on);
            if (!on) speech.stop();
          }}
          networkConsent={networkConsent}
          onConsent={() => {
            consentRef.current = true;
            setNetworkConsent(true);
            setSpeechNote("");
          }}
          note={speechNote}
        />

        <div className="space-y-6 p-4 sm:p-6">
          {earlier.map((conversation, index) => (
            <details key={index} className="border-l-4 border-moss pl-4">
              <summary className="min-h-12 cursor-pointer py-2 font-bold [overflow-wrap:anywhere]">
                Earlier conversation, read-only ({conversation.turns.length}{" "}
                {conversation.turns.length === 1 ? "turn" : "turns"})
              </summary>
              <div className="mt-3">
                <Transcript
                  turns={conversation.turns}
                  unsent={conversation.unsent}
                  readOnly
                  idPrefix={`earlier-${index}`}
                />
              </div>
            </details>
          ))}

          <AssistantWelcome
            onPick={pickDraft}
            showActions={turns.length === 0 && !showSending && !unsent}
            disabled={sending || phase.kind === "unavailable"}
          />

          {turns.length > 0 || showSending || unsent ? (
            <Transcript
              turns={turns}
              unsent={showSending ?? unsent}
              thinking={showSending !== null}
              readOnly={ended}
              liveReviewTurn={liveReviewTurn}
              focusTurn={focusTurn}
              idPrefix="current"
              playback={
                speechState.supported && speechState.choice.kind !== "none"
                  ? {
                      speakingId: speechState.speakingId,
                      onListen: (id, text) => speakReply(id, text, false),
                      onStop: () => speech.stop(),
                    }
                  : undefined
              }
            />
          ) : null}

          {phase.kind === "retry" ? (
            <Notice
              title={RETRY_COPY[phase.reason].title}
              noticeRef={noticeRef}
            >
              <p>{RETRY_COPY[phase.reason].body}</p>
              <div className="flex flex-wrap items-center gap-4">
                <RetryButton
                  key={phase.attempt}
                  retryAfterS={phase.retryAfterS}
                  onRetry={retry}
                />
                <button
                  type="button"
                  onClick={startNewConversation}
                  className={secondaryButtonClass}
                >
                  Start a new conversation
                </button>
              </div>
            </Notice>
          ) : null}

          {phase.kind === "ended" ? (
            <Notice title={END_COPY[phase.reason].title} noticeRef={noticeRef}>
              <p>
                {END_COPY[phase.reason].body} Your messages stay on this page,
                read-only.
              </p>
              <button
                type="button"
                onClick={startNewConversation}
                className={buttonClass}
              >
                Start a new conversation
              </button>
            </Notice>
          ) : null}

          {phase.kind === "unavailable" ? (
            <Notice
              title="The assistant isn't switched on"
              noticeRef={noticeRef}
            >
              <p>
                This demo has no assistant connected right now. Try again in a
                moment, or go back to the workshop page.
              </p>
              <div className="flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  onClick={tryAgain}
                  className={buttonClass}
                >
                  Try again
                </button>
                <Link href="/" className={linkClass}>
                  Back to workshop
                </Link>
              </div>
            </Notice>
          ) : null}

          {phase.kind === "rejected" ? (
            <Notice title="That message wasn't accepted" noticeRef={noticeRef}>
              <p>Check the message and send it again.</p>
            </Notice>
          ) : null}
        </div>

        {showComposer ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="z-10 border-t-2 border-bottle bg-primer px-4 py-3 sm:px-6 [@media(min-height:44rem)]:sticky [@media(min-height:44rem)]:bottom-0"
          >
            <label htmlFor="message" className="text-sm font-bold">
              Your message
            </label>
            {draft !== "" && draft === initialDraft && turns.length === 0 ? (
              <p className="text-sm">
                Prepared from the page you came from. Change it or send it as it
                is.
              </p>
            ) : null}
            <textarea
              id="message"
              name="message"
              ref={textareaRef}
              rows={2}
              maxLength={MAX_MESSAGE_LENGTH}
              value={draft}
              readOnly={sending}
              onChange={(event) => {
                setDraft(event.target.value);
                setShortened(false);
                if (phase.kind === "invalid") {
                  setPhase({ kind: "idle", replied: false });
                }
              }}
              onKeyDown={onKeyDown}
              aria-describedby="message-help message-count"
              aria-invalid={phase.kind === "invalid" || undefined}
              className="mt-1 block w-full resize-y border-2 border-bottle bg-white px-3 py-2 text-lg"
            />
            <div className="mt-1 flex flex-wrap justify-between gap-x-4 text-sm">
              <p id="message-help">
                Enter sends, Shift and Enter adds a line. Plain text only, and
                please don&apos;t type personal details.
              </p>
              <p id="message-count">
                {draft.length} of {MAX_MESSAGE_LENGTH} characters
              </p>
            </div>
            {shortened ? (
              <p role="status" className="text-sm font-bold">
                The transcript was shortened to fit {MAX_MESSAGE_LENGTH}{" "}
                characters. Check the end of your message before sending.
              </p>
            ) : null}
            {phase.kind === "invalid" ? (
              <div
                role="alert"
                tabIndex={-1}
                ref={noticeRef}
                className="mt-2 border-l-8 border-rust bg-white p-2 font-bold text-rust"
              >
                Write a message of 1 to {MAX_MESSAGE_LENGTH} characters.
              </div>
            ) : null}
            <div className="mt-3 flex flex-wrap items-start gap-x-4 gap-y-3">
              <VoiceInput
                controlRef={voice}
                onRecordingStart={onRecordingStart}
                onTranscript={addTranscript}
                onReviewChange={setReviewing}
                disabled={sending || phase.kind === "unavailable"}
              />
              <button
                type="submit"
                disabled={sending || phase.kind === "unavailable"}
                aria-busy={sending}
                className={`${buttonClass} ml-auto`}
              >
                {sending
                  ? "Sending…"
                  : transcriptReady
                    ? "Send transcript"
                    : "Send message"}
              </button>
            </div>
            {turns.length > 0 && !sending ? (
              <p className="mt-2">
                <button
                  type="button"
                  onClick={startNewConversation}
                  className="min-h-12 font-bold underline underline-offset-4"
                >
                  Start a new conversation
                </button>
              </p>
            ) : null}
          </form>
        ) : null}

        <p role="status" className="sr-only">
          {status}
        </p>
      </section>

      <aside aria-label="How this answer was made" className="min-w-0">
        <details
          ref={timelineRef}
          className="border-2 border-bottle bg-white/70 p-4"
        >
          <summary className="min-h-12 cursor-pointer font-display text-2xl font-extrabold [overflow-wrap:anywhere]">
            How this answer was made
          </summary>
          <div className="mt-4">
            <p className="mb-4 max-w-prose">
              What you wrote, which tools the assistant asked for and what the
              schedule service answered. It never shows the assistant&apos;s
              reasoning.
            </p>
            <ExecutionTimeline
              turns={turns.map((turn) => ({
                turnIndex: turn.response.turn_index,
                events: turn.response.events,
              }))}
            />
          </div>
        </details>
      </aside>
    </div>
  );
}
