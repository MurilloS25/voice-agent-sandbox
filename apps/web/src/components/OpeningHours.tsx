import type { OpeningInterval } from "@/lib/api/client";
import {
  WEEKDAY_NAMES,
  formatClockTime,
  formatTimezoneLabel,
} from "@/lib/format";

export function OpeningHours({
  hours,
  timezone,
}: {
  hours: OpeningInterval[];
  timezone: string;
}) {
  return (
    <section
      aria-labelledby="hours-heading"
      className="on-dark self-start bg-bottle p-4 text-primer sm:p-8"
    >
      <h2
        id="hours-heading"
        className="font-display text-4xl font-extrabold [overflow-wrap:anywhere] sm:text-5xl"
      >
        Opening hours
      </h2>
      <dl className="mt-5 divide-y divide-current/30">
        {WEEKDAY_NAMES.map((name, weekday) => {
          const intervals = hours
            .filter((interval) => interval.weekday === weekday)
            .sort((a, b) => a.start.localeCompare(b.start));
          return (
            <div key={name} className="flex flex-wrap gap-x-3 py-2">
              <dt className="shrink-0 basis-[min(100%,6.5rem)] font-bold [overflow-wrap:anywhere]">
                {name}
              </dt>
              <dd className="min-w-[min(100%,11rem)] flex-1">
                {intervals.length === 0
                  ? "Closed"
                  : intervals.map((i) => (
                      // One interval per line; the no-break space keeps "2:00 PM" together.
                      <span key={i.start} className="block">
                        {`${formatClockTime(i.start)} to ${formatClockTime(i.end)}`.replace(
                          /[  ](?=[AP]M)/g,
                          " ",
                        )}
                      </span>
                    ))}
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="mt-5 text-sm">
        All times are {formatTimezoneLabel(timezone)}.
      </p>
    </section>
  );
}
