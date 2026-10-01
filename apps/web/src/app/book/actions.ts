"use server";

import { redirect } from "next/navigation";

import { confirmAppointment } from "@/lib/api/client";

import type { BookingActionState } from "./state";

/**
 * The only place a booking is created. Treated as a public POST endpoint: the token is
 * validated (shape and length) and re-verified by the API, and the return value is reduced
 * to a small state object.
 *
 * Only a known 4xx refusal is reported as "nothing was booked". Anything else (a 5xx, an
 * unreadable response, an unreachable API, a timeout) leaves the outcome unknown, so it is
 * reported as `unavailable`, where retrying is safe because confirming is idempotent.
 */
export async function confirmBooking(
  _previous: BookingActionState,
  formData: FormData,
): Promise<BookingActionState> {
  const token = formData.get("proposal_token");
  if (typeof token !== "string") return { kind: "invalid" };

  const result = await confirmAppointment(token);

  if (result.kind === "ok") {
    // redirect() throws, so it stays outside any try/catch.
    redirect(`/appointments/${encodeURIComponent(result.data.id)}`);
  }
  if (result.kind === "unavailable") return { kind: "unavailable" };

  switch (result.code) {
    case "slot_unavailable":
      return { kind: "conflict" };
    case "proposal_stale":
      return { kind: "stale" };
    case "proposal_expired":
      return { kind: "expired" };
    case "proposal_invalid":
    case "validation_error":
      return { kind: "invalid" };
    case "slot_not_offered":
    case "date_out_of_range":
      return { kind: "not_offered" };
  }

  // An unrecognised response may have come after the booking was saved.
  if (
    result.status >= 500 ||
    result.code === "invalid_response" ||
    result.code === "unexpected_error"
  ) {
    return { kind: "unavailable" };
  }
  return { kind: "error" };
}
