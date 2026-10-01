import type {
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
