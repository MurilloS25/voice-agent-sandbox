import type { Money } from "@/lib/api/client";

// A fixed locale keeps server and client output identical.
const LOCALE = "en-US";

export const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/**
 * Formats a minor-unit amount using the currency the API returned.
 *
 * Intl throws a RangeError for a malformed currency code. One bad price must not take down
 * the whole page, so fall back to a plain number followed by the code as received. The
 * fallback assumes two fraction digits because the real minor unit is unknown.
 */
export function formatPrice(money: Money): string {
  try {
    const formatter = new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency: money.currency,
    });
    // USD has 2 fraction digits, JPY has 0: ask Intl instead of assuming 100.
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(money.amount_minor / 10 ** digits);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const amount = new Intl.NumberFormat(LOCALE, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(money.amount_minor / 100);
    return `${amount} ${String(money.currency).slice(0, 8)}`.trim();
  }
}

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** Formats a UTC instant as a clock time in the given IANA timezone. */
export function formatSlotTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
}

/** Formats a local "HH:MM" opening time. */
export function formatClockTime(hhmm: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(`1970-01-01T${hhmm}:00Z`));
}

/** Formats a calendar date ("YYYY-MM-DD") without any timezone shifting. */
export function formatCalendarDate(isoDate: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

/** Weekday index of a calendar date, Monday = 0, matching the API. */
export function weekdayIndex(isoDate: string): number {
  return (new Date(`${isoDate}T12:00:00Z`).getUTCDay() + 6) % 7;
}

/** e.g. "Eastern Time (America/New_York)". */
export function formatTimezoneLabel(timeZone: string): string {
  const parts = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    timeZoneName: "longGeneric",
  }).formatToParts(new Date());
  const name =
    parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone;
  return `${name} (${timeZone})`;
}
