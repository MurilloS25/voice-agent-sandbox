/** What the confirm action tells the form. `kind` drives the message and the next step. */
export type BookingActionState =
  | { kind: "idle" }
  | { kind: "conflict" } // the time was just taken
  | { kind: "stale" } // the service details changed since the review
  | { kind: "expired" } // the review timed out
  | { kind: "discarded" } // the review was withdrawn or replaced; nothing was booked
  | { kind: "invalid" } // the review could not be verified
  | { kind: "not_offered" } // the time is no longer offered (e.g. now inside the lead time)
  | { kind: "unavailable" } // the outcome is unknown: retrying is safe
  | { kind: "error" }; // a known refusal with no better message: nothing was booked

export const IDLE: BookingActionState = { kind: "idle" };
