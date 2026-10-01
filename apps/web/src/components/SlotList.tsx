import Link from "next/link";

import type { Availability } from "@/lib/api/client";
import {
  WEEKDAY_NAMES,
  formatCalendarDate,
  formatSlotTime,
  formatTimezoneLabel,
  weekdayIndex,
} from "@/lib/format";

type SlotListProps = {
  availability: Availability;
  serviceId: string;
  serviceName: string;
  /** True when the shop has no opening hours on the requested weekday. */
  shopClosed: boolean;
};

export function reviewHref(serviceId: string, startIso: string): string {
  return `/book?service=${encodeURIComponent(serviceId)}&start=${encodeURIComponent(startIso)}`;
}

export function SlotList({
  availability,
  serviceId,
  serviceName,
  shopClosed,
}: SlotListProps) {
  const { slots, timezone, date } = availability;
  const dateLabel = formatCalendarDate(date);

  if (slots.length === 0) {
    return (
      <p className="max-w-prose [overflow-wrap:anywhere]">
        {shopClosed
          ? `The shop is closed on ${WEEKDAY_NAMES[weekdayIndex(date)]}s. Choose another date.`
          : `No open times for ${serviceName} on ${dateLabel}. Every bench is taken or the start times have passed. Choose another date.`}
      </p>
    );
  }

  const minutes = Math.round(
    (new Date(slots[0].end).getTime() - new Date(slots[0].start).getTime()) /
      60000,
  );

  return (
    <>
      <p className="max-w-prose [overflow-wrap:anywhere]">
        {slots.length} open {slots.length === 1 ? "start time" : "start times"}{" "}
        for {serviceName} on {dateLabel}. The job takes {minutes} minutes. Times
        are {formatTimezoneLabel(timezone)}. Choose a time to review the
        booking; nothing is booked until you confirm.
      </p>
      <ul className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-3">
        {slots.map((slot) => (
          <li key={slot.start}>
            <Link
              href={reviewHref(serviceId, slot.start)}
              className="block bg-hivis px-2 py-2 text-center font-display text-2xl leading-none font-extrabold text-bottle hover:bg-celeste sm:px-3 sm:text-3xl"
            >
              <time dateTime={slot.start}>
                {formatSlotTime(slot.start, timezone)}
              </time>
              <span className="sr-only">
                , review the booking for {serviceName}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
