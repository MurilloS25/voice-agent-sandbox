"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode, RefObject } from "react";

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
import { draftFor } from "@/lib/assistant-link";
import { newUuid } from "@/lib/uuid";
import {
  PREVIEW_SPEECH_ID,
  PREVIEW_TEXT,
  WELCOME_SPEECH_ID,
} from "@/lib/voice/stage";
import { useSpeechOutput } from "@/lib/voice/use-speech-output";

import { AssistantWelcome, WELCOME_TEXT } from "./AssistantWelcome";
import { ExecutionTimeline } from "./ExecutionTimeline";
import { SecondaryPanel } from "./SecondaryPanel";
import { ReviewBlock, Transcript, type ReviewAgain } from "./Transcript";
import { VoiceInput, type VoiceControl } from "./VoiceInput";
import { VoiceSettings } from "./VoiceSettings";
import { VoiceStage } from "./VoiceStage";

export type AssistantMode = "voice" | "text";
type PanelKind = "transcript" | "timeline" | "settings";

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
  "min-h-12 rounded-full bg-bottle px-6 py-2 text-lg font-bold [overflow-wrap:anywhere] text-cream hover:bg-moss disabled:opacity-60";
const secondaryButtonClass =
  "min-h-12 rounded-full border border-bottle/40 bg-white px-5 py-2 font-bold [overflow-wrap:anywhere] hover:bg-celeste/40";
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
      className="max-w-prose rounded-2xl border-l-8 border-rust bg-white p-4 shadow-[0_2px_14px_-6px_rgb(15_59_54/0.35)]"
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

const toolbarButton =
  "inline-flex min-h-12 items-center rounded-full px-4 py-2 text-sm font-bold [overflow-wrap:anywhere] hover:bg-celeste/40";

export function ChatPanel({
  initialDraft = "",
  initialMode = "voice",
}: {
  initialDraft?: string;
  initialMode?: AssistantMode;
}) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [earlier, setEarlier] = useState<Conversation[]>([]);
  const [draft, setDraft] = useState(initialDraft);
  // A link can change the context while the chat is open (for example "Review again"). Each new
  // context is looked at once: it prepares the draft only if the box is empty, and the cursor
  // goes there. Text the visitor wrote is never changed, and an ignored or applied context does
  // not come back after the box is cleared. The conversation is never reset.
  const [seenDraft, setSeenDraft] = useState(initialDraft);
  const [contextFocus, setContextFocus] = useState(0);
  if (initialDraft !== seenDraft) {
    setSeenDraft(initialDraft);
    if (initialDraft !== "" && draft.trim() === "") {
      setDraft(initialDraft);
      setContextFocus((count) => count + 1);
    }
  }

  const [mode, setMode] = useState<AssistantMode>(initialMode);
  const [panel, setPanel] = useState<PanelKind | null>(null);
  // The visitor started the voice session. It lives in memory only: a reload starts it again.
  const [sessionActive, setSessionActive] = useState(false);
  // A transcript is waiting in the box for the visitor to check, edit and send (or discard).
  const [transcriptPending, setTranscriptPending] = useState(false);
  // A reply that automatic reading could not start, so the stage can offer to read it.
  const [unheard, setUnheard] = useState<{ id: string; text: string } | null>(
    null,
  );

  const [pending, setPending] = useState<Pending | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle", replied: false });
  const [focusTurn, setFocusTurn] = useState<number | null>(null);
  // Counts transcripts placed in the box, so the box takes focus after each one.
  const [transcripts, setTranscripts] = useState(0);
  // The merged transcript did not fit in 500 characters and its end was cut off.
  const [shortened, setShortened] = useState(false);
  const voice = useRef<VoiceControl>(null);
  // A transcript is in the box and has not been sent yet (text composer); and which text it was.
  const [reviewing, setReviewing] = useState(false);
  const lastTranscript = useRef("");

  // Spoken replies. The network-voice agreement lives in memory only; refs mirror what the async
  // code reads after a turn comes back.
  const { output: speech, snapshot: speechState } = useSpeechOutput();
  const [networkConsent, setNetworkConsent] = useState(false);
  const [speechNote, setSpeechNote] = useState("");
  const consentRef = useRef(false);
  // Replies are read automatically only while the voice session is on and Voice is showing.
  const autoReadRef = useRef(false);
  useEffect(() => {
    autoReadRef.current = mode === "voice" && sessionActive;
  }, [mode, sessionActive]);

  const inFlight = useRef(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const previousPanel = useRef<PanelKind | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Leaving the page or the component always stops speaking.
  useEffect(() => {
    const stopSpeaking = () => speech.stop();
    window.addEventListener("pagehide", stopSpeaking);
    return () => {
      window.removeEventListener("pagehide", stopSpeaking);
      speech.stop();
    };
  }, [speech]);

  // Closing a panel gives focus back to the control that opened it.
  useEffect(() => {
    if (previousPanel.current !== null && panel === null) {
      openerRef.current?.focus();
    }
    previousPanel.current = panel;
  }, [panel]);

  /**
   * Reads one assistant reply aloud. Only its visible text is passed on, nothing else. An
   * automatic reading counts as done only once the browser reports that it started; a refusal
   * or a failure leaves the reply unread and the stage offers to read it.
   */
  function speakReply(id: string, text: string, automatic: boolean) {
    const result = speech.speak(id, text, {
      allowNetwork: consentRef.current,
      onStart: () => {
        setUnheard((current) => (current?.id === id ? null : current));
      },
      onError: () => {
        if (automatic) setUnheard({ id, text });
      },
    });
    if (result === "needs_consent" && !automatic) {
      setSpeechNote(
        "Only a network voice is available. Agree to it in Voice settings first.",
      );
    } else if (result === "started") {
      setSpeechNote("");
    }
    if (automatic && result !== "started") setUnheard({ id, text });
    // A refusal (for example an autoplay block) is silent: Listen and "Read reply aloud" stay.
  }

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
    if (transcripts === 0 || mode !== "text") return;
    const box = textareaRef.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [transcripts, mode]);

  // A context that arrived while the page was open puts the cursor in the prepared draft.
  useEffect(() => {
    if (contextFocus === 0 || mode !== "text") return;
    const box = textareaRef.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [contextFocus, mode]);

  // A sent message must be in view in the conversation, whatever the visitor scrolled to.
  const showingSending = phase.kind === "sending";
  useEffect(() => {
    const log = logRef.current;
    if (showingSending && log) log.scrollTop = log.scrollHeight;
  }, [showingSending]);

  /**
   * A click on "Review again" is a new request each time, even for the same service and day. It
   * prepares the draft only in an empty box and never sends. (A context that arrives through the
   * address is handled once, above.)
   */
  function reviewAgain(context: ReviewAgain) {
    const text = draftFor(context);
    if (text === "" || draft.trim() !== "") return;
    setDraft(text);
    setContextFocus((count) => count + 1);
  }

  /**
   * A quick start fills the box, and only when it is empty: text the visitor wrote is never
   * replaced or extended. Nothing is sent. (The buttons are disabled while the box has text.)
   */
  function pickDraft(text: string) {
    if (draft.trim() !== "") return;
    setDraft(text);
    setShortened(false);
    setPhase((current) =>
      current.kind === "invalid" ? { kind: "idle", replied: false } : current,
    );
    textareaRef.current?.focus();
  }

  /** A new recording silences the assistant. */
  function onRecordingStart() {
    speech.stop();
  }

  /** The transcript joins what is already typed. It is never sent from here: only Send sends. */
  function addTranscript(text: string) {
    const heard = text.trim();
    // In the voice review the transcript is the whole message: Record again replaces it, edits
    // included. It is replaced only now that a new one has arrived, so a failed or cancelled
    // recording loses nothing.
    if (mode === "voice" && transcriptPending) {
      lastTranscript.current = heard;
      setDraft(heard.slice(0, MAX_MESSAGE_LENGTH));
      setShortened(heard.length > MAX_MESSAGE_LENGTH);
    } else {
      // In the text composer, recording again replaces the last transcript if it was left as it
      // was, and keeps what the visitor typed.
      const previous = lastTranscript.current;
      let base = draft.trim();
      if (previous && base.endsWith(previous)) {
        base = base.slice(0, base.length - previous.length).trim();
      }
      lastTranscript.current = heard;
      const merged = [base, heard].filter((part) => part.length > 0).join(" ");
      setDraft(merged.slice(0, MAX_MESSAGE_LENGTH));
      setShortened(merged.length > MAX_MESSAGE_LENGTH); // typed text is kept; the end is cut
    }
    setTranscriptPending(true);
    setPhase((current) =>
      current.kind === "invalid" ? { kind: "idle", replied: false } : current,
    );
    setTranscripts((count) => count + 1);
  }

  /** Throws away the transcript that is waiting (and only it: text typed before stays). */
  function discardTranscript() {
    const previous = lastTranscript.current;
    if (previous) {
      setDraft((current) => {
        const text = current.trim();
        return text.endsWith(previous)
          ? text.slice(0, text.length - previous.length).trim()
          : current;
      });
    }
    lastTranscript.current = "";
    setTranscriptPending(false);
    setShortened(false);
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
        // Only while the voice session is on, and only for an assistant reply that is new.
        if (autoReadRef.current && outcome.turn.reply.source === "assistant") {
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
    setTranscriptPending(false);
    setUnheard(null);
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
    setUnheard(null);
    setTranscriptPending(false);
    lastTranscript.current = "";
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

  // --- the voice session -------------------------------------------------------------------

  /**
   * Starts the voice session. It runs inside the visitor's click, so the browser lets the
   * welcome play: the fixed local text is spoken from this gesture, with nothing awaited first.
   * It is not a turn: no model call, no conversation, no counter, nothing in the history. It
   * turns on automatic reading of replies that arrive from now on, and it never records.
   */
  function startSession() {
    setSessionActive(true);
    const result = speech.speak(WELCOME_SPEECH_ID, WELCOME_TEXT, {
      allowNetwork: consentRef.current,
    });
    if (result === "needs_consent") {
      setSpeechNote(
        "Only a network voice is available, so the welcome and the replies are not read aloud until you agree to it.",
      );
    } else {
      setSpeechNote("");
    }
  }

  /** Ends the voice session: speech stops, automatic reading is off, the conversation stays. */
  function endSession() {
    speech.stop();
    voice.current?.cancel();
    discardTranscript();
    setUnheard(null);
    setSessionActive(false);
  }

  function chooseMode(next: AssistantMode) {
    if (next === mode) return;
    speech.stop(); // leaving one mode never leaves the other talking
    setMode(next);
    if (next === "text" && panel === "transcript") setPanel(null);
  }

  function togglePanel(kind: PanelKind, event: MouseEvent<HTMLElement>) {
    if (panel === kind) {
      setPanel(null);
      return;
    }
    openerRef.current = event.currentTarget;
    // Below the wide layout a panel takes the place of the stage, so a recording behind it
    // would be unreachable: end it, and stop talking.
    if (!window.matchMedia?.("(min-width: 1024px)").matches) {
      voice.current?.cancel();
      speech.stop();
    }
    setPanel(kind);
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
  const liveReview =
    liveReviewTurn === null
      ? null
      : (turns.find((t) => t.response.turn_index === liveReviewTurn)?.response
          .booking_review ?? null);
  const unsent =
    pending && !sending && phase.kind !== "idle" ? pending.message : null;
  const showSending = sending && pending ? pending.message : null;
  const speechUsable =
    speechState.supported && speechState.choice.kind !== "none";
  const playback = speechUsable
    ? {
        speakingId: speechState.speakingId,
        onListen: (id: string, text: string) => speakReply(id, text, false),
        onStop: () => speech.stop(),
      }
    : undefined;

  const status =
    phase.kind === "sending"
      ? "Sending your message."
      : phase.kind === "idle" && phase.replied
        ? "The assistant replied."
        : "";

  /** Problems with the turn itself. They look the same in both modes. */
  const problem: ReactNode =
    phase.kind === "retry" ? (
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
            className={secondaryButtonClass}
          >
            Start a new conversation
          </button>
        </div>
      </Notice>
    ) : phase.kind === "ended" ? (
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
    ) : phase.kind === "unavailable" ? (
      <Notice title="The assistant isn't switched on" noticeRef={noticeRef}>
        <p>
          This demo has no assistant connected right now. Try again in a moment,
          or go back to the workshop page.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <button type="button" onClick={tryAgain} className={buttonClass}>
            Try again
          </button>
          <Link href="/" className={linkClass}>
            Back to workshop
          </Link>
        </div>
      </Notice>
    ) : phase.kind === "rejected" ? (
      <Notice title="That message wasn't accepted" noticeRef={noticeRef}>
        <p>Check the message and send it again.</p>
      </Notice>
    ) : phase.kind === "invalid" && mode === "voice" ? (
      <Notice title="That message can't be sent" noticeRef={noticeRef}>
        <p>Write a message of 1 to {MAX_MESSAGE_LENGTH} characters.</p>
      </Notice>
    ) : null;

  /** A network voice is the only one that works, and the visitor has not agreed to it. */
  const needsConsent =
    speechState.supported &&
    speechState.choice.kind === "network" &&
    !networkConsent;

  const consentNote: ReactNode =
    sessionActive && needsConsent ? (
      <div className="space-y-2 rounded-2xl border-l-8 border-rust bg-white p-3">
        <p className="font-bold text-rust">Replies are not read aloud yet</p>
        <p className="text-sm">
          The selected voice is a network voice: it may send the text of each
          reply to a speech service run by your browser or operating system.
          Nothing is spoken until you agree.
        </p>
        <button
          type="button"
          onClick={consent}
          className={secondaryButtonClass}
        >
          Use the network voice
        </button>
      </div>
    ) : null;

  function consent() {
    consentRef.current = true;
    setNetworkConsent(true);
    setSpeechNote("");
  }

  // --- pieces shared by the surfaces ------------------------------------------------------

  const log = (variant: "text" | "panel") => (
    <>
      {earlier.map((conversation, index) => (
        <details
          key={index}
          className="rounded-2xl border border-bottle/15 bg-white/70 px-4"
        >
          <summary className="min-h-12 cursor-pointer py-2 font-bold [overflow-wrap:anywhere]">
            Earlier conversation, read-only ({conversation.turns.length}{" "}
            {conversation.turns.length === 1 ? "turn" : "turns"})
          </summary>
          <div className="pb-3">
            <Transcript
              turns={conversation.turns}
              unsent={conversation.unsent}
              readOnly
              idPrefix={`${variant}-earlier-${index}`}
              onReviewAgain={reviewAgain}
            />
          </div>
        </details>
      ))}

      <AssistantWelcome
        onPick={pickDraft}
        showActions={
          variant === "text" && turns.length === 0 && !showSending && !unsent
        }
        disabled={sending || phase.kind === "unavailable"}
        boxHasText={draft.trim() !== ""}
      />

      {turns.length > 0 || showSending || unsent ? (
        <Transcript
          turns={turns}
          unsent={showSending ?? unsent}
          thinking={showSending !== null}
          readOnly={ended}
          liveReviewTurn={liveReviewTurn}
          liveReviewElsewhere={variant === "panel"}
          focusTurn={variant === "text" ? focusTurn : null}
          idPrefix={variant === "text" ? "current" : "panel"}
          onReviewAgain={reviewAgain}
          playback={playback}
        />
      ) : null}
    </>
  );

  const activityPanel = (
    <>
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
    </>
  );

  const settingsPanel = (
    <VoiceSettings
      snapshot={speechState}
      networkConsent={networkConsent}
      onConsent={consent}
      onVoice={(name) => speech.setSettings({ voiceName: name })}
      onRate={(rate) => speech.setSettings({ rate })}
      onPreview={() => {
        const result = speech.speak(PREVIEW_SPEECH_ID, PREVIEW_TEXT, {
          allowNetwork: consentRef.current,
        });
        setSpeechNote(
          result === "needs_consent"
            ? "Only a network voice is available. Agree to it first."
            : "",
        );
      }}
      onStopPreview={() => speech.stop()}
      onReset={() => speech.resetSettings()}
      note={speechNote}
    />
  );

  const panelTitle: Record<PanelKind, string> = {
    transcript: "Transcript",
    timeline: "How this answer was made",
    settings: "Voice settings",
  };

  const voiceBusy: "thinking" | "speaking" | null = sending
    ? "thinking"
    : speechState.speakingId !== null
      ? "speaking"
      : null;
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const typedDraft =
    mode === "voice" && !transcriptPending && draft.trim() !== "";

  const voiceFooter = null;

  const stage = (
    <VoiceStage
      sessionActive={sessionActive}
      onStart={startSession}
      onEnd={endSession}
      busy={voiceBusy}
      onStopSpeaking={() => speech.stop()}
      draft={draft}
      onDraft={(text) => {
        setDraft(text);
        setShortened(false);
        if (phase.kind === "invalid")
          setPhase({ kind: "idle", replied: false });
      }}
      transcriptPending={transcriptPending}
      onTranscript={addTranscript}
      onRecordingStart={onRecordingStart}
      onSend={() => submit()}
      onCancelTranscript={discardTranscript}
      controlRef={voice}
      welcome={
        <AssistantWelcome
          onPick={pickDraft}
          showActions={false}
          disabled
          boxHasText={false}
        />
      }
      lastTurn={lastTurn}
      sendingMessage={showSending}
      unheard={unheard !== null && !needsConsent}
      onReadAloud={() => {
        if (unheard) speakReply(unheard.id, unheard.text, false);
      }}
      speechAvailable={speechUsable}
      speechNote={
        <>
          {consentNote}
          {!consentNote && speechNote ? (
            <p role="status" className="text-sm font-bold">
              {speechNote}
            </p>
          ) : null}
          {typedDraft ? (
            <div className="space-y-2 rounded-2xl bg-white p-3 shadow-[0_2px_14px_-6px_rgb(15_59_54/0.35)]">
              <p className="[overflow-wrap:anywhere]">
                <span className="font-bold">
                  A message is waiting in Text:{" "}
                </span>
                {draft}
              </p>
              <button
                type="button"
                onClick={() => chooseMode("text")}
                className={secondaryButtonClass}
              >
                Review it in Text
              </button>
            </div>
          ) : null}
        </>
      }
      problem={problem}
      review={
        liveReview && liveReviewTurn !== null ? (
          <ReviewBlock
            review={liveReview}
            live
            turnIndex={liveReviewTurn}
            onReviewAgain={reviewAgain}
            className=""
          />
        ) : null
      }
      onSwitchToText={() => chooseMode("text")}
      footer={voiceFooter}
    />
  );

  const textMode = (
    <section
      aria-labelledby="chat-heading"
      className="flex h-full min-h-0 min-w-0 flex-col rounded-3xl bg-white/70 shadow-[0_10px_40px_-18px_rgb(15_59_54/0.5)]"
    >
      <h2 id="chat-heading" className="sr-only">
        Conversation
      </h2>

      <div
        ref={logRef}
        className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 sm:p-6"
      >
        {log("text")}
        {problem && phase.kind !== "invalid" ? problem : null}
      </div>

      {showComposer ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="max-h-[60%] shrink-0 overflow-y-auto rounded-b-3xl border-t border-bottle/15 bg-cream px-4 py-3 sm:px-6"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
            <label htmlFor="message" className="text-sm font-bold">
              Your message
            </label>
            <p id="message-count" className="text-sm">
              {draft.length} of {MAX_MESSAGE_LENGTH} characters
            </p>
          </div>
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
            className="mt-1 block w-full resize-y rounded-2xl border border-bottle/40 bg-white px-3 py-2 text-lg"
          />
          <p id="message-help" className="mt-1 text-sm">
            Enter sends, Shift and Enter adds a line. Please don&apos;t type
            personal details.
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
              className="mt-2 rounded-xl border-l-8 border-rust bg-white p-2 font-bold text-rust"
            >
              Write a message of 1 to {MAX_MESSAGE_LENGTH} characters.
            </div>
          ) : null}
          <VoiceInput
            controlRef={voice}
            onRecordingStart={onRecordingStart}
            onTranscript={addTranscript}
            onReviewChange={setReviewing}
            disabled={sending || phase.kind === "unavailable"}
            actions={
              <button
                type="submit"
                disabled={sending || phase.kind === "unavailable"}
                aria-busy={sending}
                className={buttonClass}
              >
                {sending
                  ? "Sending…"
                  : transcriptReady
                    ? "Send transcript"
                    : "Send message"}
              </button>
            }
          />
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
    </section>
  );

  const panelBody =
    panel === "transcript"
      ? log("panel")
      : panel === "timeline"
        ? activityPanel
        : panel === "settings"
          ? settingsPanel
          : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 pb-2 sm:px-8">
        <div
          role="group"
          aria-label="Assistant mode"
          className="inline-flex rounded-full bg-white/80 p-1 shadow-inner"
        >
          {(["voice", "text"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => chooseMode(value)}
              className={`min-h-12 rounded-full px-6 py-2 font-bold ${
                mode === value ? "bg-bottle text-cream" : "hover:bg-celeste/40"
              }`}
            >
              {value === "voice" ? "Voice" : "Text"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center">
          {mode === "voice" ? (
            <button
              type="button"
              aria-expanded={panel === "transcript"}
              aria-controls="panel-transcript"
              onClick={(event) => togglePanel("transcript", event)}
              className={toolbarButton}
            >
              View transcript
            </button>
          ) : null}
          <button
            type="button"
            aria-expanded={panel === "timeline"}
            aria-controls="panel-timeline"
            onClick={(event) => togglePanel("timeline", event)}
            className={toolbarButton}
          >
            How this answer was made
          </button>
          <button
            type="button"
            aria-expanded={panel === "settings"}
            aria-controls="panel-settings"
            onClick={(event) => togglePanel("settings", event)}
            className={toolbarButton}
          >
            Voice settings
          </button>
        </div>
      </div>

      <div
        className={`grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-4 px-4 pb-4 sm:px-8 ${
          panel ? "lg:grid-cols-[minmax(0,1fr)_26rem]" : ""
        }`}
      >
        <div className={`min-h-0 min-w-0 ${panel ? "max-lg:hidden" : ""}`}>
          {mode === "voice" ? stage : textMode}
        </div>
        {panel ? (
          <SecondaryPanel
            key={panel}
            id={`panel-${panel}`}
            title={panelTitle[panel]}
            onClose={() => setPanel(null)}
            endKey={panel === "transcript" ? turns.length : undefined}
          >
            {panelBody}
          </SecondaryPanel>
        ) : null}
      </div>

      <p role="status" className="sr-only">
        {status}
      </p>
    </div>
  );
}
