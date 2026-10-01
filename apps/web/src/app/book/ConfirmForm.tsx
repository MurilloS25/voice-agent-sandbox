"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";

import { confirmBooking } from "./actions";
import { IDLE, type BookingActionState } from "./state";

type ConfirmFormProps = {
  /** The signed proposal token. It is not a secret: the API verifies it again on confirm. */
  token: string;
  /** Where to re-run the review for the same service and time. */
  reviewHref: string;
  /** Where to choose a different time. */
  availabilityHref: string;
};

type Outcome = Exclude<BookingActionState, { kind: "idle" }>;

const linkClass = "font-bold underline underline-offset-4";

function Outcome({
  state,
  reviewHref,
  availabilityHref,
}: {
  state: Outcome;
  reviewHref: string;
  availabilityHref: string;
}) {
  switch (state.kind) {
    case "conflict":
      return (
        <>
          <p className="text-lg font-bold text-rust">
            That time was just taken
          </p>
          <p className="mt-1">
            Someone booked it while you were reviewing. Nothing was booked.{" "}
            <Link href={availabilityHref} className={linkClass}>
              Choose another time
            </Link>
            .
          </p>
        </>
      );
    case "stale":
      return (
        <>
          <p className="text-lg font-bold text-rust">The details changed</p>
          <p className="mt-1">
            The service details changed since you reviewed this booking. Nothing
            was booked.{" "}
            <Link href={reviewHref} className={linkClass}>
              Review again
            </Link>
            .
          </p>
        </>
      );
    case "expired":
      return (
        <>
          <p className="text-lg font-bold text-rust">This review expired</p>
          <p className="mt-1">
            Reviews are only valid for a few minutes. Nothing was booked.{" "}
            <Link href={reviewHref} className={linkClass}>
              Review again
            </Link>
            .
          </p>
        </>
      );
    case "invalid":
      return (
        <>
          <p className="text-lg font-bold text-rust">
            This review could not be verified
          </p>
          <p className="mt-1">
            Nothing was booked.{" "}
            <Link href={reviewHref} className={linkClass}>
              Review again
            </Link>
            .
          </p>
        </>
      );
    case "not_offered":
      return (
        <>
          <p className="text-lg font-bold text-rust">
            That time is no longer offered
          </p>
          <p className="mt-1">
            Start times close shortly before the job, and this one has passed
            that point. Nothing was booked.{" "}
            <Link href={availabilityHref} className={linkClass}>
              Choose another time
            </Link>
            .
          </p>
        </>
      );
    case "unavailable":
      return (
        <>
          <p className="text-lg font-bold text-rust">
            The schedule service isn&apos;t responding
          </p>
          <p className="mt-1">
            We can&apos;t tell whether the booking was saved. Try again:
            confirming the same review twice never books twice.
          </p>
        </>
      );
    case "error":
      return (
        <>
          <p className="text-lg font-bold text-rust">Something went wrong</p>
          <p className="mt-1">
            The booking was not confirmed. Try again, or{" "}
            <Link href={reviewHref} className={linkClass}>
              review it again
            </Link>
            .
          </p>
        </>
      );
  }
}

/** Kinds where resubmitting the same token could still succeed. */
function canRetry(state: BookingActionState): boolean {
  return (
    state.kind === "idle" ||
    state.kind === "unavailable" ||
    state.kind === "error"
  );
}

export function ConfirmForm({
  token,
  reviewHref,
  availabilityHref,
}: ConfirmFormProps) {
  const [state, formAction, pending] = useActionState(confirmBooking, IDLE);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.kind !== "idle") alertRef.current?.focus();
  }, [state]);

  return (
    <form action={formAction} className="mt-8 max-w-2xl">
      <input type="hidden" name="proposal_token" value={token} />

      {state.kind !== "idle" && (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="mb-4 border-l-8 border-rust bg-white/60 p-4"
        >
          <Outcome
            state={state}
            reviewHref={reviewHref}
            availabilityHref={availabilityHref}
          />
        </div>
      )}

      {canRetry(state) && (
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className="min-h-12 max-w-full bg-bottle px-4 py-2 text-lg font-bold text-primer hover:bg-moss disabled:opacity-60 sm:px-8"
        >
          {pending
            ? "Confirming…"
            : state.kind === "idle"
              ? "Confirm booking"
              : "Try again"}
        </button>
      )}

      <p role="status" className="sr-only">
        {pending ? "Confirming your booking." : ""}
      </p>
    </form>
  );
}
