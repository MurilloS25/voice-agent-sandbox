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

import { ExecutionTimeline } from "./ExecutionTimeline";
import { Transcript } from "./Transcript";
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

const SUGGESTIONS = [
  "What does the shop do?",
  "How much is a flat repair?",
  "Do you have time for a flat repair on Tuesday?",
];

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
      className="max-w-prose border-l-8 border-rust bg-white/60 p-4"
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

export function ChatPanel() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [earlier, setEarlier] = useState<Conversation[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle", replied: false });
  const [focusTurn, setFocusTurn] = useState<number | null>(null);
  // Counts transcripts placed in the box, so the box takes focus after each one.
  const [transcripts, setTranscripts] = useState(0);
  // The merged transcript did not fit in 500 characters and its end was cut off.
  const [shortened, setShortened] = useState(false);
  const voice = useRef<VoiceControl>(null);

  const inFlight = useRef(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timelineRef = useRef<HTMLDetailsElement>(null);

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

  /** The transcript joins what is already typed. It is never sent from here: only Send sends. */
  function addTranscript(text: string) {
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

  function submit() {
    if (inFlight.current || pending) return;
    if (phase.kind === "unavailable" || phase.kind === "ended") return;
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

  function retry() {
    if (pending) void run(pending);
  }

  function startNewConversation() {
    voice.current?.cancel();
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
    <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:gap-14">
      <section aria-labelledby="chat-heading" className="space-y-6">
        <h2
          id="chat-heading"
          className="font-display text-4xl font-extrabold [overflow-wrap:anywhere] sm:text-5xl"
        >
          Conversation
        </h2>

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

        {turns.length === 0 && !showSending && !unsent ? (
          <div className="max-w-prose space-y-3">
            <p>
              Ask about services, prices, opening hours or open times. The
              assistant is an AI. It can prepare a booking review for a time the
              shop offers, but only you can confirm one.
            </p>
            <p className="font-bold">Try asking</p>
            <ul className="flex flex-wrap gap-3">
              {SUGGESTIONS.map((suggestion) => (
                <li key={suggestion}>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(suggestion);
                      textareaRef.current?.focus();
                    }}
                    disabled={sending || phase.kind === "unavailable"}
                    className="min-h-12 border-2 border-bottle bg-white px-4 py-2 text-left [overflow-wrap:anywhere] hover:bg-hivis"
                  >
                    {suggestion}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <Transcript
            turns={turns}
            unsent={showSending ?? unsent}
            readOnly={ended}
            liveReviewTurn={liveReviewTurn}
            focusTurn={focusTurn}
            idPrefix="current"
          />
        )}

        {phase.kind === "retry" ? (
          <Notice title={RETRY_COPY[phase.reason].title} noticeRef={noticeRef}>
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
                className="min-h-12 border-2 border-bottle px-4 py-2 font-bold [overflow-wrap:anywhere] hover:bg-hivis"
              >
                Start a new conversation
              </button>
            </div>
            <p>
              <Link href="/#availability" className={linkClass}>
                Book with the form instead
              </Link>
            </p>
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
          <Notice title="The assistant isn't switched on" noticeRef={noticeRef}>
            <p>
              This demo has no assistant connected right now. You can still book
              with the form.
            </p>
            <p>
              <Link href="/#availability" className={linkClass}>
                Book with the form instead
              </Link>
            </p>
          </Notice>
        ) : null}

        {phase.kind === "rejected" ? (
          <Notice title="That message wasn't accepted" noticeRef={noticeRef}>
            <p>Check the message and send it again.</p>
          </Notice>
        ) : null}

        {showComposer ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="max-w-2xl"
          >
            <label htmlFor="message" className="font-bold">
              Your message
            </label>
            <textarea
              id="message"
              name="message"
              ref={textareaRef}
              rows={3}
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
              className="mt-1 block w-full border-2 border-bottle bg-white px-3 py-2 text-lg"
            />
            <p id="message-help" className="mt-1 text-sm">
              Press Enter to send, or Shift and Enter for a new line. Plain text
              only, and please don&apos;t type personal details.
            </p>
            <p id="message-count" className="text-sm">
              {draft.length} of {MAX_MESSAGE_LENGTH} characters
            </p>
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
                className="mt-2 border-l-8 border-rust bg-white/60 p-2 font-bold text-rust"
              >
                Write a message of 1 to {MAX_MESSAGE_LENGTH} characters.
              </div>
            ) : null}
            <VoiceInput
              controlRef={voice}
              onTranscript={addTranscript}
              disabled={sending || phase.kind === "unavailable"}
            />
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <button
                type="submit"
                disabled={sending || phase.kind === "unavailable"}
                aria-busy={sending}
                className={buttonClass}
              >
                {sending ? "Sending…" : "Send message"}
              </button>
              {turns.length > 0 && !sending ? (
                <button
                  type="button"
                  onClick={startNewConversation}
                  className="min-h-12 border-2 border-bottle px-4 py-2 font-bold [overflow-wrap:anywhere] hover:bg-hivis"
                >
                  Start a new conversation
                </button>
              ) : null}
            </div>
          </form>
        ) : null}

        <p role="status" className="sr-only">
          {status}
        </p>
      </section>

      <aside aria-label="Execution timeline" className="min-w-0">
        <details ref={timelineRef} className="border-t-4 border-bottle pt-4">
          <summary className="min-h-12 cursor-pointer font-display text-3xl font-extrabold [overflow-wrap:anywhere]">
            Execution timeline
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
