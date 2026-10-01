-- Fictional catalog for Quillwheel Cycle Works. Mirrors infrastructure/seed.py, and a parity
-- integration test fails if the two drift. Nothing here describes a real business or person.
-- Seed appointments are not created here: `python -m voice_agent_api.demo_reset` does that.

set local search_path = pg_catalog, extensions;

insert into booking.businesses
  (id, name, tagline, address, phone, timezone, currency,
   slot_interval_minutes, min_lead_minutes, booking_horizon_days)
values
  ('quillwheel', 'Quillwheel Cycle Works', 'Honest repairs for everyday bikes.',
   '14 Lantern Lane, Juniper Crossing, NY', '+1 212-555-0142',
   'America/New_York', 'USD', 30, 120, 14);

insert into booking.benches (business_id, bench_no)
values ('quillwheel', 1), ('quillwheel', 2);

insert into booking.services
  (business_id, id, name, description, duration_minutes, price_amount_minor, currency)
values
  ('quillwheel', 'flat-repair', 'Flat repair',
   'Patch or replace a punctured tube and check the tire.', 30, 1500, 'USD'),
  ('quillwheel', 'brake-adjustment', 'Brake adjustment',
   'Center, tighten, and test rim or disc brakes.', 45, 3500, 'USD'),
  ('quillwheel', 'wheel-truing', 'Wheel truing',
   'Straighten a wobbling wheel and set spoke tension.', 60, 4000, 'USD'),
  ('quillwheel', 'standard-tune-up', 'Standard tune-up',
   'Brakes, gears, chain, and bolts checked and adjusted.', 90, 8500, 'USD'),
  ('quillwheel', 'full-overhaul', 'Full overhaul',
   'Strip, clean, regrease, and rebuild the whole bike.', 240, 22000, 'USD');

-- Tuesday to Friday (weekday 1-4): 09:00-13:00 and 14:00-18:00. Saturday (5): 09:00-14:00.
-- Closed Sunday and Monday.
insert into booking.opening_hours (business_id, weekday, opens_at, closes_at)
select 'quillwheel', d.weekday, h.opens_at, h.closes_at
from (values (1), (2), (3), (4)) as d (weekday)
cross join (values ('09:00'::time, '13:00'::time), ('14:00'::time, '18:00'::time))
  as h (opens_at, closes_at);

insert into booking.opening_hours (business_id, weekday, opens_at, closes_at)
values ('quillwheel', 5, '09:00', '14:00');
