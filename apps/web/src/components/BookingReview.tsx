import type { AppointmentProposal } from "@/lib/api/client";
import {
  formatCalendarDate,
  formatDuration,
  formatPrice,
  formatSlotTime,
  formatTimezoneLabel,
  localDateOf,
} from "@/lib/format";

import { DetailRow } from "./DetailRow";

/** Exactly what confirming will book, as computed by the schedule service. Saves nothing. */
export function BookingReview({ proposal }: { proposal: AppointmentProposal }) {
  const { service, start, end, timezone, customer_alias, expires_at } =
    proposal;
  return (
    <>
      <dl className="max-w-2xl">
        <DetailRow label="Service">{service.name}</DetailRow>
        <DetailRow label="Date">
          {formatCalendarDate(localDateOf(start, timezone))}
        </DetailRow>
        <DetailRow label="Time">
          <time dateTime={start}>{formatSlotTime(start, timezone)}</time> to{" "}
          <time dateTime={end}>{formatSlotTime(end, timezone)}</time>
        </DetailRow>
        <DetailRow label="Duration">
          {formatDuration(service.duration_minutes)}
        </DetailRow>
        <DetailRow label="Time zone">{formatTimezoneLabel(timezone)}</DetailRow>
        <DetailRow label="Price">{formatPrice(service.price)}</DetailRow>
        <DetailRow label="Name on booking (fictional)">
          {customer_alias}
        </DetailRow>
      </dl>
      <p className="mt-4 max-w-prose">
        Nothing has been booked yet. This review is valid until{" "}
        <time dateTime={expires_at}>
          {formatSlotTime(expires_at, timezone)}
        </time>
        , and the time is not held for you while you review it.
      </p>
    </>
  );
}
