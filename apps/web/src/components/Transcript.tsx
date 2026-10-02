"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { ConfirmForm } from "@/app/book/ConfirmForm";
import type { Turn } from "@/app/assistant/state";
import { BookingReview } from "@/components/BookingReview";
import { reviewHref } from "@/components/SlotList";
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
  /** Earlier conversations are read-only: no confirm button anywhere in them. */
  readOnly?: boolean;
  /** The turn whose review may be confirmed here, if any. */
  liveReviewTurn?: number | null;
  /** The turn whose response takes focus. Set only after the visitor sent a message. */
  focusTurn?: number | null;
  /** Keeps element ids unique when several transcripts are on the page. */
  idPrefix: string;
  /** Listen / Stop on assistant replies. Omitted when no voice is available or read-only. */
  playback?: Playback;
};

const labelClass = "font-bold";
const textClass = "mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]";

function Message({
  who,
  tone,
  children,
  id,
  focusable,
}: {
  who: string;
  tone: "user" | "assistant" | "system";
  children: ReactNode;
  id?: string;
  focusable?: boolean;
}) {
  const toneClass = {
    user: "border-bottle bg-white",
    assistant: "border-moss bg-celeste/40",
    system: "border-rust bg-white/60",
  }[tone];
  return (
    <div
      id={id}
      tabIndex={focusable ? -1 : undefined}
      className={`max-w-prose border-l-8 p-3 ${toneClass}`}
    >
      <p className={labelClass}>{who}</p>
      <p className={textClass}>{children}</p>
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
      className="min-h-12 border-2 border-bottle px-4 py-2 font-bold [overflow-wrap:anywhere] hover:bg-hivis"
    >
      {speaking ? "Stop" : "Listen"}
    </button>
  );
}

function availabilityHref(review: Review): string {
  const date = tryLocalDateOf(review.start, review.timezone);
  return date
    ? `/?service=${encodeURIComponent(review.service.id)}&date=${date}#availability`
    : "/#availability";
}

function ReviewBlock({ review, live }: { review: Review; live: boolean }) {
  const again = reviewHref(review.service.id, review.start);
  return (
    <section
      aria-label="Booking review"
      className="mt-3 max-w-2xl border-l-8 border-bottle bg-white p-4"
    >
      <p className="font-bold">
        Review prepared by the schedule service — nothing is booked until you
        confirm.
      </p>
      <div className="mt-3">
        <BookingReview proposal={review} />
      </div>
      {live ? (
        <ConfirmForm
          token={review.proposal_token}
          reviewHref={again}
          availabilityHref={availabilityHref(review)}
        />
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
  readOnly = false,
  liveReviewTurn = null,
  focusTurn = null,
  idPrefix,
  playback,
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
          <li key={response.turn_index} className="space-y-3">
            <Message who="You" tone="user">
              {turn.message}
            </Message>
            <div
              data-focus-turn={response.turn_index}
              tabIndex={-1}
              id={`${idPrefix}-reply-${response.turn_index}`}
              className="space-y-3"
            >
              <Message
                who={fromAssistant ? "Assistant (AI)" : "System"}
                tone={fromAssistant ? "assistant" : "system"}
              >
                {response.reply.text}
              </Message>
              {fromAssistant && playback ? (
                <ListenButton
                  turnIndex={response.turn_index}
                  id={`${idPrefix}-${response.turn_index}`}
                  text={response.reply.text}
                  playback={playback}
                />
              ) : null}
              {review ? (
                <ReviewBlock
                  review={review}
                  live={!readOnly && liveReviewTurn === response.turn_index}
                />
              ) : null}
            </div>
          </li>
        );
      })}
      {unsent ? (
        <li>
          <Message who="You (not answered yet)" tone="user">
            {unsent}
          </Message>
        </li>
      ) : null}
    </ol>
  );
}
