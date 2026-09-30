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
  serviceName: string;
  /** True when the shop has no opening hours on the requested weekday. */
  shopClosed: boolean;
};

export function SlotList({
  availability,
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
        are {formatTimezoneLabel(timezone)}.
      </p>
      <ul className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-3">
        {slots.map((slot) => (
          <li
            key={slot.start}
            className="bg-hivis px-2 py-2 text-center font-display text-2xl leading-none font-extrabold text-bottle sm:px-3 sm:text-3xl"
          >
            <time dateTime={slot.start}>
              {formatSlotTime(slot.start, timezone)}
            </time>
          </li>
        ))}
      </ul>
    </>
  );
}
