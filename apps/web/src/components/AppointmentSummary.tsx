import type { Appointment } from "@/lib/api/client";
import {
  formatCalendarDate,
  formatDuration,
  formatPrice,
  formatSlotTime,
  formatTimezoneLabel,
  localDateOf,
} from "@/lib/format";

import { DetailRow } from "./DetailRow";

/** What the schedule service confirmed and saved, as read back from the record. */
export function AppointmentSummary({
  appointment,
}: {
  appointment: Appointment;
}) {
  const { service, start, end, timezone } = appointment;
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
          {appointment.customer_alias}
        </DetailRow>
        <DetailRow label="Bench">{`Bench ${appointment.bench}`}</DetailRow>
        <DetailRow label="Booking reference">
          <code>{appointment.id}</code>
        </DetailRow>
      </dl>
      <p className="mt-4 max-w-prose">
        Confirmed and saved by the schedule service at{" "}
        <time dateTime={appointment.created_at}>
          {formatSlotTime(appointment.created_at, timezone)}
        </time>
        . You chose this time and confirmed it yourself.
      </p>
    </>
  );
}
