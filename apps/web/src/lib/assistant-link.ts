import { formatCalendarDate } from "@/lib/format";

/**
 * The only context a link into the assistant may carry: a service id and a calendar date. Both
 * only pre-fill a visible, editable draft. A time is never carried: the agent must offer times
 * itself, in an earlier turn, before it can prepare a review.
 */
export type AssistantContext = { service?: string; date?: string };

const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isServiceId(value: string | undefined): value is string {
  return value !== undefined && SERVICE_ID.test(value);
}

export function isCalendarDate(value: string | undefined): value is string {
  if (value === undefined || !CALENDAR_DATE.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/** Keeps only the well-formed parts of untrusted values. */
export function sanitizeContext(raw: {
  service?: string;
  date?: string;
}): AssistantContext {
  return {
    ...(isServiceId(raw.service) ? { service: raw.service } : {}),
    ...(isCalendarDate(raw.date) ? { date: raw.date } : {}),
  };
}

/** `/assistant`, with a service and/or date when they are well-formed. */
export function assistantHref(context: AssistantContext = {}): string {
  const safe = sanitizeContext(context);
  const query = new URLSearchParams();
  if (safe.service) query.set("service", safe.service);
  if (safe.date) query.set("date", safe.date);
  const text = query.toString();
  return text ? `/assistant?${text}` : "/assistant";
}

/** The draft a visitor sees (and may edit) for a context. Nothing here is sent by itself. */
export function draftFor(context: {
  serviceName?: string;
  date?: string;
}): string {
  const when = context.date ? formatCalendarDate(context.date) : undefined;
  if (context.serviceName && when) {
    return `Do you have time for ${context.serviceName} on ${when}?`;
  }
  if (context.serviceName) {
    return `What open times do you have for ${context.serviceName}?`;
  }
  if (when) return `What open times do you have on ${when}?`;
  return "";
}
