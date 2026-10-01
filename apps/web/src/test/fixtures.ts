import type {
  AgentTurn,
  Appointment,
  AppointmentProposal,
  Availability,
  Business,
  Service,
} from "@/lib/api/client";

export const services: Service[] = [
  {
    id: "flat-repair",
    name: "Flat repair",
    description: "Patch or replace a punctured tube.",
    duration_minutes: 30,
    price: { amount_minor: 1500, currency: "USD" },
  },
  {
    id: "standard-tune-up",
    name: "Standard tune-up",
    description: "Brakes, gears, chain, and bolts.",
    duration_minutes: 90,
    price: { amount_minor: 8500, currency: "USD" },
  },
];

export const business: Business = {
  id: "quillwheel",
  name: "Quillwheel Cycle Works",
  tagline: "Honest repairs for everyday bikes.",
  address: "14 Lantern Lane, Juniper Crossing, NY",
  phone: "+1 212-555-0142",
  timezone: "America/New_York",
  currency: "USD",
  slot_interval_minutes: 30,
  hours: [
    { weekday: 1, start: "14:00", end: "18:00" },
    { weekday: 1, start: "09:00", end: "13:00" },
    { weekday: 5, start: "09:00", end: "14:00" },
  ],
  booking_window: { first_date: "2026-09-30", last_date: "2026-10-14" },
};

export const availability: Availability = {
  service_id: "flat-repair",
  date: "2026-10-01",
  timezone: "America/New_York",
  slots: [
    { start: "2026-10-01T13:00:00Z", end: "2026-10-01T13:30:00Z" },
    { start: "2026-10-01T15:30:00Z", end: "2026-10-01T16:00:00Z" },
  ],
};

export const proposal: AppointmentProposal = {
  proposal_token: "v1.eyJ2IjoxfQ.c2lnbmF0dXJl",
  expires_at: "2026-09-30T12:10:00Z",
  service: services[0],
  start: "2026-10-01T13:00:00Z",
  end: "2026-10-01T13:30:00Z",
  timezone: "America/New_York",
  customer_alias: "Demo Amber Heron",
};

export const appointment: Appointment = {
  id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  status: "confirmed",
  // The saved snapshot: no description, and the duration is end minus start.
  service: {
    id: "flat-repair",
    name: "Flat repair",
    duration_minutes: 30,
    price: { amount_minor: 1500, currency: "USD" },
  },
  start: "2026-10-01T13:00:00Z",
  end: "2026-10-01T13:30:00Z",
  timezone: "America/New_York",
  customer_alias: "Demo Amber Heron",
  bench: 1,
  source: "web_demo",
  created_at: "2026-09-30T12:03:00Z",
};

export const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

const at = "2026-09-30T12:00:00Z";

/** A completed assistant turn with the minimal timeline. Override any field. */
export function agentTurn(
  turnIndex = 1,
  overrides: Partial<AgentTurn> = {},
): AgentTurn {
  return {
    conversation_id: CONVERSATION_ID,
    client_turn_id: `22222222-2222-4222-8222-22222222222${turnIndex}`,
    turn_index: turnIndex,
    outcome: "completed",
    reply: { source: "assistant", text: `Answer ${turnIndex}.` },
    events: [
      {
        seq: 1,
        at,
        kind: "user_message",
        actor: "user",
        text: `Question ${turnIndex}`,
      },
      {
        seq: 2,
        at,
        kind: "assistant_message",
        actor: "assistant",
        text: `Answer ${turnIndex}.`,
      },
    ],
    booking_review: null,
    ...overrides,
  };
}

/** A turn that prepared a review, as the API returns it. */
export function reviewTurn(turnIndex = 1, overrides: Partial<AgentTurn> = {}) {
  return agentTurn(turnIndex, {
    reply: {
      source: "assistant",
      text: "The review is shown below. Nothing is booked until you confirm.",
    },
    booking_review: proposal,
    events: [
      {
        seq: 1,
        at,
        kind: "user_message",
        actor: "user",
        text: "The first one",
      },
      {
        seq: 2,
        at,
        kind: "tool_requested",
        actor: "assistant",
        tool: "prepare_booking_review",
        input: {
          service_id: null,
          date: null,
          days: null,
          earliest_local_time: null,
          latest_local_time: null,
          slot_id: "S1",
        },
      },
      {
        seq: 3,
        at,
        kind: "tool_result",
        actor: "tool",
        tool: "prepare_booking_review",
        status: "ok",
        duration_ms: 12,
        summary: "Prepared a review for Flat repair.",
        code: null,
      },
      {
        seq: 4,
        at,
        kind: "booking_review_ready",
        actor: "tool",
        service_name: "Flat repair",
        local_date: "2026-10-01",
        local_start: "09:00",
        local_end: "09:30",
        timezone: "America/New_York",
        price_display: "15.00 USD",
      },
      {
        seq: 5,
        at,
        kind: "assistant_message",
        actor: "assistant",
        text: "The review is shown below.",
      },
    ],
    ...overrides,
  });
}
