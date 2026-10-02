import Link from "next/link";

import type { Availability } from "@/lib/api/client";
import { assistantHref } from "@/lib/assistant-link";
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

const linkClass = "font-bold underline underline-offset-4";

/**
 * Open times are information here, not links: a booking starts in the assistant, and no time
 * ever travels in a URL. The one link carries only the service and the day.
 */
export function SlotList({
  availability,
  serviceId,
  serviceName,
  shopClosed,
}: SlotListProps) {
  const { slots, timezone, date } = availability;
  const dateLabel = formatCalendarDate(date);
  const assistant = assistantHref({ service: serviceId, date });

  if (slots.length === 0) {
    return (
      <div className="space-y-3">
        <p className="max-w-prose [overflow-wrap:anywhere]">
          {shopClosed
            ? `The shop is closed on ${WEEKDAY_NAMES[weekdayIndex(date)]}s. Choose another date.`
            : `No open times for ${serviceName} on ${dateLabel}. Every bench is taken or the start times have passed. Choose another date.`}
        </p>
        <p>
          <Link href={assistant} className={linkClass}>
            Ask the assistant for other options
          </Link>
        </p>
      </div>
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
        are {formatTimezoneLabel(timezone)}. To book one, ask the assistant;
        nothing is booked until you confirm.
      </p>
      <ul
        aria-label={`Open start times for ${serviceName}`}
        className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-3"
      >
        {slots.map((slot) => (
          <li
            key={slot.start}
            className="border-2 border-bottle bg-white px-2 py-2 text-center font-display text-2xl leading-none font-extrabold sm:px-3 sm:text-3xl"
          >
            <time dateTime={slot.start}>
              {formatSlotTime(slot.start, timezone)}
            </time>
          </li>
        ))}
      </ul>
      <p className="mt-6">
        <Link
          href={assistant}
          className="inline-block min-h-12 bg-bottle px-6 py-3 text-lg font-bold [overflow-wrap:anywhere] text-primer hover:bg-moss"
        >
          Ask the assistant to book {serviceName}
        </Link>
      </p>
    </>
  );
}
