import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TimelineEvent } from "@/lib/api/client";
import { expectNoA11yViolations } from "@/test/axe";
import { agentTurn, reviewTurn } from "@/test/fixtures";

import { ExecutionTimeline } from "./ExecutionTimeline";

const at = "2026-09-30T12:00:00Z";
const none = {
  service_id: null,
  date: null,
  days: null,
  earliest_local_time: null,
  latest_local_time: null,
  slot_id: null,
};

/** One of every discriminated event kind (with every code of the enums that have them). */
const ALL: TimelineEvent[] = [
  { seq: 1, at, kind: "user_message", actor: "user", text: "hello" },
  {
    seq: 2,
    at,
    kind: "tool_requested",
    actor: "assistant",
    tool: "find_available_slots",
    input: {
      ...none,
      service_id: "flat-repair",
      date: "2026-10-06",
      days: 2,
      earliest_local_time: "09:30",
      latest_local_time: "17:00",
    },
  },
  {
    seq: 3,
    at,
    kind: "tool_result",
    actor: "tool",
    tool: "find_available_slots",
    status: "ok",
    duration_ms: 14,
    summary: "Found 3 open time(s) for Flat repair.",
    code: null,
  },
  {
    seq: 4,
    at,
    kind: "tool_result",
    actor: "tool",
    tool: "prepare_booking_review",
    status: "rejected",
    duration_ms: 3,
    summary: "That time was just taken.",
    code: "slot_unavailable",
  },
  {
    seq: 5,
    at,
    kind: "tool_result",
    actor: "tool",
    tool: "list_services",
    status: "error",
    duration_ms: 7500,
    summary: "The tool took too long.",
    code: "tool_timeout",
  },
  {
    seq: 6,
    at,
    kind: "booking_review_ready",
    actor: "tool",
    service_name: "Flat repair",
    local_date: "2026-10-06",
    local_start: "09:00",
    local_end: "09:30",
    timezone: "America/New_York",
    price_display: "15.00 USD",
  },
  { seq: 7, at, kind: "assistant_message", actor: "assistant", text: "ok" },
  { seq: 8, at, kind: "system_message", actor: "system", text: "notice" },
  {
    seq: 9,
    at,
    kind: "guardrail",
    actor: "system",
    code: "invalid_tool_input",
    tool: "find_available_slots",
    issues: ["date:value_error"],
  },
  {
    seq: 10,
    at,
    kind: "guardrail",
    actor: "system",
    code: "tool_not_allowed",
    tool: null,
    issues: [],
  },
  {
    seq: 11,
    at,
    kind: "provider_error",
    actor: "system",
    code: "model_timeout",
  },
  {
    seq: 12,
    at,
    kind: "provider_error",
    actor: "system",
    code: "model_rate_limited",
  },
  {
    seq: 13,
    at,
    kind: "turn_error",
    actor: "system",
    code: "storage_unavailable",
  },
  {
    seq: 14,
    at,
    kind: "turn_error",
    actor: "system",
    code: "turn_deadline_exceeded",
  },
];

describe("ExecutionTimeline", () => {
  it("explains the empty timeline", () => {
    render(<ExecutionTimeline turns={[]} />);
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
  });

  it("renders every event kind in order, inside an ordered list per turn", () => {
    const { container } = render(
      <ExecutionTimeline turns={[{ turnIndex: 1, events: ALL }]} />,
    );

    expect(screen.getByRole("heading", { name: "Turn 1" })).toBeInTheDocument();
    expect(container.querySelectorAll("ol ol > li")).toHaveLength(ALL.length);
    const text = container.textContent ?? "";
    for (const expected of [
      "You wrote",
      "The assistant asked for: Open times",
      "service: flat-repair",
      "date: 2026-10-06",
      "days: 2",
      "from: 09:30",
      "until: 17:00",
      "Open times worked (14 ms)",
      "Booking review was refused (3 ms)",
      "Service list failed (7500 ms)",
      "result: slot_unavailable",
      "result: tool_timeout",
      "The schedule service prepared a booking review",
      "Flat repair, 2026-10-06, 09:00 to 09:30 (America/New_York), 15.00 USD",
      "The assistant (AI) replied",
      "A system notice was shown",
      "A tool request with invalid details was refused",
      "date:value_error",
      "A tool that is not allowed was refused",
      "The assistant took too long to answer",
      "The assistant was busy",
      "The schedule service was unavailable",
      "The turn ran out of time",
    ]) {
      expect(text).toContain(expected);
    }
  });

  it("states the outcome in words, not only by position or colour", () => {
    render(<ExecutionTimeline turns={[{ turnIndex: 1, events: ALL }]} />);
    expect(screen.getByText(/was refused \(3 ms\)/)).toBeInTheDocument();
    expect(screen.getByText(/failed \(7500 ms\)/)).toBeInTheDocument();
  });

  it("renders hostile text as plain text: no element, no link", () => {
    const hostile: TimelineEvent[] = [
      {
        seq: 1,
        at,
        kind: "user_message",
        actor: "user",
        text: '<img src=x onerror="alert(1)"> <a href="http://evil.example">x</a> [m](http://evil.example)',
      },
      {
        seq: 2,
        at,
        kind: "tool_result",
        actor: "tool",
        tool: "<script>alert(1)</script>",
        status: "ok",
        duration_ms: 1,
        summary: "<b>bold</b>",
        code: null,
      },
    ];
    const { container } = render(
      <ExecutionTimeline turns={[{ turnIndex: 1, events: hostile }]} />,
    );

    expect(container.querySelector("img, script, b, a")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.textContent).toContain("<b>bold</b>");
  });

  it("never shows a token, an id or reasoning that the contract does not carry", () => {
    const turn = reviewTurn(1);
    const { container } = render(
      <ExecutionTimeline turns={[{ turnIndex: 1, events: turn.events }]} />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain(turn.booking_review?.proposal_token);
    expect(text).not.toMatch(/v1\.[A-Za-z0-9_-]{8,}\./);
    expect(text).not.toContain(turn.conversation_id);
    expect(text).not.toContain(turn.client_turn_id);
    expect(text.toLowerCase()).not.toContain("reasoning:");
  });

  it("lists several turns", () => {
    render(
      <ExecutionTimeline
        turns={[
          { turnIndex: 1, events: agentTurn(1).events },
          { turnIndex: 2, events: agentTurn(2).events },
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: "Turn 2" })).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <ExecutionTimeline turns={[{ turnIndex: 1, events: ALL }]} />,
    );
    await expectNoA11yViolations(container);
  });
});
