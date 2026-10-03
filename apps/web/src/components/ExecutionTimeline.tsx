import type { ReactNode } from "react";

import type { TimelineEvent } from "@/lib/api/client";

export type TimelineTurn = { turnIndex: number; events: TimelineEvent[] };

type ToolInputView = Extract<
  TimelineEvent,
  { kind: "tool_requested" }
>["input"];

const TOOL_LABELS: Record<string, string> = {
  get_business_info: "Business details",
  list_services: "Service list",
  find_available_slots: "Open times",
  prepare_booking_review: "Booking review",
  discard_booking_review: "Withdraw booking review",
};

const DISCARD_REASONS = {
  declined: "you declined it.",
  changed_search: "you asked about another service or day.",
  replaced: "a new review replaced it.",
} as const;

const GUARDRAIL_LABELS: Record<string, string> = {
  tool_not_allowed: "A tool that is not allowed was refused",
  invalid_tool_input: "A tool request with invalid details was refused",
  tool_budget_exceeded: "Too many tool requests: the extra ones were ignored",
  model_call_budget_exceeded: "The assistant used up its steps for this turn",
};

const PROVIDER_LABELS: Record<string, string> = {
  model_timeout: "The assistant took too long to answer",
  model_rate_limited: "The assistant was busy",
  model_unavailable: "The assistant could not answer",
  model_bad_output: "The assistant gave an unusable answer",
};

const TURN_ERROR_LABELS: Record<string, string> = {
  turn_deadline_exceeded: "The turn ran out of time",
  storage_unavailable: "The schedule service was unavailable",
  internal_error: "Something went wrong inside the service",
};

function toolName(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

/** Only the fields the API allows, as short "name: value" chips. Nothing else is rendered. */
function inputChips(input: ToolInputView): string[] {
  const chips: string[] = [];
  if (input.service_id) chips.push(`service: ${input.service_id}`);
  if (input.date) chips.push(`date: ${input.date}`);
  if (input.days) chips.push(`days: ${input.days}`);
  if (input.earliest_local_time) {
    chips.push(`from: ${input.earliest_local_time}`);
  }
  if (input.latest_local_time) chips.push(`until: ${input.latest_local_time}`);
  if (input.slot_id) chips.push(`slot: ${input.slot_id}`);
  return chips;
}

function Chips({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-wrap gap-2">
      {items.map((item) => (
        <li
          key={item}
          className="border border-bottle bg-white px-2 text-sm [overflow-wrap:anywhere]"
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

function Row({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <>
      <p className="font-bold [overflow-wrap:anywhere]">{label}</p>
      {children}
    </>
  );
}

const STATUS_WORDS = { ok: "worked", rejected: "was refused", error: "failed" };

/** Every event kind is handled; a new kind in the API contract fails type-checking here. */
function EventBody({ event }: { event: TimelineEvent }) {
  switch (event.kind) {
    case "user_message":
      return (
        <Row label="You wrote">
          <p className="[overflow-wrap:anywhere] whitespace-pre-wrap">
            {event.text}
          </p>
        </Row>
      );
    case "tool_requested":
      return (
        <Row label={`The assistant asked for: ${toolName(event.tool)}`}>
          <Chips items={inputChips(event.input)} />
        </Row>
      );
    case "tool_result":
      return (
        <Row
          label={`${toolName(event.tool)} ${STATUS_WORDS[event.status]} (${event.duration_ms} ms)`}
        >
          <p className="[overflow-wrap:anywhere]">{event.summary}</p>
          {event.code ? <Chips items={[`result: ${event.code}`]} /> : null}
        </Row>
      );
    case "booking_review_ready":
      return (
        <Row label="The schedule service prepared a booking review">
          <p className="[overflow-wrap:anywhere]">
            {event.service_name}, {event.local_date}, {event.local_start} to{" "}
            {event.local_end} ({event.timezone}), {event.price_display}. Nothing
            is booked until you confirm.
          </p>
        </Row>
      );
    case "booking_review_discarded":
      return (
        <Row label="A booking review is no longer active">
          <p className="[overflow-wrap:anywhere]">
            {event.service_name}, {event.local_date}, {event.local_start}:{" "}
            {DISCARD_REASONS[event.reason]} Nothing was booked and nothing was
            cancelled.
          </p>
        </Row>
      );
    case "assistant_message":
      return <Row label="The assistant (AI) replied" />;
    case "system_message":
      return <Row label="A system notice was shown" />;
    case "guardrail":
      return (
        <Row label={GUARDRAIL_LABELS[event.code] ?? "A guardrail applied"}>
          <Chips
            items={[
              ...(event.tool ? [`tool: ${toolName(event.tool)}`] : []),
              ...event.issues,
            ]}
          />
        </Row>
      );
    case "provider_error":
      return (
        <Row
          label={PROVIDER_LABELS[event.code] ?? "The assistant had a problem"}
        />
      );
    case "turn_error":
      return (
        <Row
          label={TURN_ERROR_LABELS[event.code] ?? "The turn had a problem"}
        />
      );
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

/**
 * What happened in each turn: what you wrote, which tools the assistant asked for and what the
 * schedule service answered. It shows decisions and results only, never the assistant's
 * reasoning, and every value is rendered as plain text.
 */
export function ExecutionTimeline({ turns }: { turns: TimelineTurn[] }) {
  if (turns.length === 0) {
    return (
      <p className="max-w-prose">
        Nothing yet. Send a message and each step the assistant takes will be
        listed here.
      </p>
    );
  }
  return (
    <ol className="space-y-6">
      {turns.map((turn) => (
        <li key={turn.turnIndex}>
          <h3 className="font-display text-2xl font-extrabold">
            Turn {turn.turnIndex}
          </h3>
          <ol className="mt-2 space-y-3 border-l-4 border-bottle pl-4">
            {turn.events.map((event) => (
              <li key={event.seq}>
                <EventBody event={event} />
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}
