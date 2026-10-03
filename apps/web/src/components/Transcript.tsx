"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { ConfirmForm } from "@/app/book/ConfirmForm";
import type { Turn } from "@/app/assistant/state";
import { BookingReview } from "@/components/BookingReview";
import { assistantHref } from "@/lib/assistant-link";
import type { AgentTurn } from "@/lib/api/client";
import { tryLocalDateOf } from "@/lib/format";

type Review = NonNullable<AgentTurn["booking_review"]>;

/** Spoken playback of replies. Present only when the browser has a usable voice. */
export type Playback = {
  /** The reply being read out, if any. */
  speakingId: string | null;
  /** Reads the visible reply text aloud. Only that text is ever passed. */
  onListen: (id: string, text: string) => void;
  onStop: () => void;
};

type TranscriptProps = {
  turns: Turn[];
  /** A message that has not been answered yet (shown while it is retried). */
  unsent?: string | null;
  /** The assistant is working on `unsent`: a placeholder reply holds its place. */
  thinking?: boolean;
  /** Earlier conversations are read-only: no confirm button anywhere in them. */
  readOnly?: boolean;
  /** The turn whose review may be confirmed here, if any. */
  liveReviewTurn?: number | null;
  /** Turns whose review was withdrawn or replaced: shown as history, never actionable. */
  discardedReviewTurns?: ReadonlySet<number>;
  /** The turn whose response takes focus. Set only after the visitor sent a message. */
  focusTurn?: number | null;
  /** Keeps element ids unique when several transcripts are on the page. */
  idPrefix: string;
  /** Listen / Stop on assistant replies. Omitted when no voice is available or read-only. */
  playback?: Playback;
  /**
   * The live booking review is on another surface (the voice stage), so here it is only
   * mentioned. Its confirm form is never rendered twice.
   */
  liveReviewElsewhere?: boolean;
  /** A plain click on a link back to the assistant (for example "Review again"). */
  onReviewAgain?: (context: ReviewAgain) => void;
};

/** What a click on a link back to the assistant means: ask again about this service and day. */
export type ReviewAgain = { serviceName: string; date?: string };

type Tone = "user" | "assistant" | "system";

/** A short text mark beside assistant and system messages, so the speaker is never only a colour. */
function Mark({ tone }: { tone: Tone }) {
  if (tone === "user") return null;
  return (
    <span
      aria-hidden="true"
      className={`mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-display text-xl leading-none font-extrabold ${
        tone === "assistant" ? "bg-bottle text-celeste" : "bg-rust text-white"
      }`}
    >
      {tone === "assistant" ? "Q" : "!"}
    </span>
  );
}

function Message({
  who,
  tone,
  children,
  footer,
}: {
  who: string;
  tone: Tone;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const bubbleClass = {
    user: "rounded-2xl rounded-br-md bg-bottle text-cream",
    assistant:
      "rounded-2xl rounded-tl-md bg-white shadow-[0_2px_14px_-6px_rgb(15_59_54/0.35)]",
    system: "rounded-2xl border-l-8 border-rust bg-white",
  }[tone];
  return (
    <div
      className={`flex min-w-0 gap-3 ${tone === "user" ? "justify-end" : ""}`}
    >
      <Mark tone={tone} />
      <div className={`max-w-prose min-w-0 p-3 ${bubbleClass}`}>
        <p className="text-sm font-bold">{who}</p>
        <p className="mt-1 [overflow-wrap:anywhere] whitespace-pre-wrap">
          {children}
        </p>
        {footer ? <div className="mt-2">{footer}</div> : null}
      </div>
    </div>
  );
}

function ListenButton({
  turnIndex,
  id,
  text,
  playback,
}: {
  turnIndex: number;
  id: string;
  text: string;
  playback: Playback;
}) {
  const speaking = playback.speakingId === id;
  return (
    <button
      type="button"
      onClick={() =>
        speaking ? playback.onStop() : playback.onListen(id, text)
      }
      aria-label={
        speaking
          ? `Stop reading reply ${turnIndex}`
          : `Listen to reply ${turnIndex}`
      }
      className="min-h-12 rounded-full border border-bottle/40 bg-white px-5 py-2 font-bold [overflow-wrap:anywhere] hover:bg-celeste/40"
    >
      {speaking ? "Stop" : "Listen"}
    </button>
  );
}

/** Back to the assistant with the service and the local day of this review. Never the time. */
function assistantAgainHref(review: Review): string {
  return assistantHref({
    service: review.service.id,
    date: tryLocalDateOf(review.start, review.timezone),
  });
}

/**
 * The schedule service's booking review and, while it is the live one, the unchanged confirm
 * form. It is rendered once on the page: where the voice stage is showing the live review, the
 * transcript points to it instead of repeating the form.
 */
export function ReviewBlock({
  review,
  live,
  turnIndex,
  onReviewAgain,
  discarded = false,
  className = "max-w-2xl sm:ml-12",
}: {
  review: Review;
  live: boolean;
  turnIndex: number;
  /** The review was withdrawn or replaced: it can no longer be confirmed. */
  discarded?: boolean;
  onReviewAgain?: (context: ReviewAgain) => void;
  className?: string;
}) {
  const again = assistantAgainHref(review);
  return (
    <section
      aria-label={
        discarded
          ? `Booking review for reply ${turnIndex} (no longer active)`
          : `Booking review for reply ${turnIndex}`
      }
      className={`rounded-2xl border bg-white p-4 ${
        discarded
          ? "border-ink/50 border-dashed"
          : "border-bottle/20 shadow-[0_8px_30px_-14px_rgb(15_59_54/0.45)]"
      } ${className}`}
      onClick={(event) => {
        // Every plain click on a link back to the assistant is a new request from the visitor,
        // even when the address does not change. The link still navigates as usual.
        if (
          !onReviewAgain ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        const link = (event.target as Element).closest("a");
        if (!link || !link.getAttribute("href")?.startsWith("/assistant")) {
          return;
        }
        onReviewAgain({
          serviceName: review.service.name,
          date: tryLocalDateOf(review.start, review.timezone),
        });
      }}
    >
      <p className="font-bold">
        {discarded
          ? "No longer active — this review was discarded or replaced."
          : "Review prepared by the schedule service — nothing is booked until you confirm."}
      </p>
      <div className="mt-3">
        <BookingReview proposal={review} />
      </div>
      {live ? (
        <ConfirmForm
          token={review.proposal_token}
          reviewHref={again}
          availabilityHref={again}
        />
      ) : discarded ? (
        <p className="mt-4">
          It can no longer be confirmed. Withdrawing it books and cancels
          nothing.{" "}
          <Link href={again} className="font-bold underline underline-offset-4">
            Review this time again
          </Link>
          .
        </p>
      ) : (
        <p className="mt-4">
          This review is not active here.{" "}
          <Link href={again} className="font-bold underline underline-offset-4">
            Review this time again
          </Link>
          .
        </p>
      )}
    </section>
  );
}

/**
 * The conversation as an ordered list. Everything the visitor or the model wrote is rendered as
 * plain text: React escapes it, nothing is parsed as Markdown or HTML, and nothing becomes a
 * link. The only link or button in a turn is the schedule service's own review block.
 */
export function Transcript({
  turns,
  unsent = null,
  thinking = false,
  readOnly = false,
  liveReviewTurn = null,
  discardedReviewTurns,
  focusTurn = null,
  idPrefix,
  playback,
  liveReviewElsewhere = false,
  onReviewAgain,
}: TranscriptProps) {
  const root = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (focusTurn === null) return;
    root.current
      ?.querySelector<HTMLElement>(`[data-focus-turn="${focusTurn}"]`)
      ?.focus();
  }, [focusTurn]);

  return (
    <ol ref={root} className="space-y-6">
      {turns.map((turn) => {
        const { response } = turn;
        const fromAssistant = response.reply.source === "assistant";
        const review = response.booking_review;
        return (
          <li key={response.turn_index} className="space-y-4">
            <Message who="You" tone="user">
              {turn.message}
            </Message>
            <div
              data-focus-turn={response.turn_index}
              tabIndex={-1}
              id={`${idPrefix}-reply-${response.turn_index}`}
              className="space-y-4"
            >
              <Message
                who={fromAssistant ? "Assistant (AI)" : "System"}
                tone={fromAssistant ? "assistant" : "system"}
                footer={
                  fromAssistant && playback ? (
                    <ListenButton
                      turnIndex={response.turn_index}
                      id={`${idPrefix}-${response.turn_index}`}
                      text={response.reply.text}
                      playback={playback}
                    />
                  ) : undefined
                }
              >
                {response.reply.text}
              </Message>
              {review &&
              liveReviewElsewhere &&
              liveReviewTurn === response.turn_index &&
              !readOnly ? (
                <p className="rounded-2xl border border-bottle/20 bg-white p-3 sm:ml-12">
                  A booking review for reply {response.turn_index} is open on
                  the voice screen. Nothing is booked until you confirm it
                  there.
                </p>
              ) : review ? (
                <ReviewBlock
                  review={review}
                  turnIndex={response.turn_index}
                  onReviewAgain={onReviewAgain}
                  live={!readOnly && liveReviewTurn === response.turn_index}
                  discarded={
                    discardedReviewTurns?.has(response.turn_index) ?? false
                  }
                />
              ) : null}
            </div>
          </li>
        );
      })}
      {unsent ? (
        <li className="space-y-4">
          <Message who="You (not answered yet)" tone="user">
            {unsent}
          </Message>
          {thinking ? (
            <div className="flex gap-3">
              <Mark tone="assistant" />
              <div className="border-2 border-moss bg-celeste/40 p-3">
                <p className="text-sm font-bold">Assistant (AI)</p>
                <p className="mt-1">
                  Working on a reply
                  <span
                    aria-hidden="true"
                    className="motion-safe:animate-pulse"
                  >
                    …
                  </span>
                </p>
              </div>
            </div>
          ) : null}
        </li>
      ) : null}
    </ol>
  );
}
