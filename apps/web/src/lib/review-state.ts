import type { AgentTurn } from "@/lib/api/client";

/**
 * Which booking review can still be confirmed.
 *
 * A review is a pending proposal, not a booking. At most one is live: the latest one, unless a
 * later turn withdrew it (the API sends a `booking_review_discarded` event when the visitor
 * declined it, when a search for another service or day replaced it, or when a new review took
 * its place). Every earlier review is superseded. The server also refuses to confirm a withdrawn
 * proposal, so this is the page showing what the server already decided, not a cosmetic hide.
 *
 * Pure and order-based: it reads only the turns' own responses, never a clock.
 */
export function reviewStatus(turns: readonly { response: AgentTurn }[]): {
  /** The turn whose review may be confirmed, or null. */
  live: number | null;
  /** Turns whose review was withdrawn or replaced: shown, never actionable. */
  discarded: ReadonlySet<number>;
} {
  let live: number | null = null;
  const discarded = new Set<number>();
  for (const { response } of turns) {
    const withdrew = response.events.some(
      (event) => event.kind === "booking_review_discarded",
    );
    if (withdrew && live !== null) {
      discarded.add(live);
      live = null;
    }
    if (response.booking_review) {
      if (live !== null) discarded.add(live); // a newer review replaces the older one
      live = response.turn_index;
    }
  }
  return { live, discarded };
}
