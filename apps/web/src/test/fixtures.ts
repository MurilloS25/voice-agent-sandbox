import type { Availability, Business, Service } from "@/lib/api/client";

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
