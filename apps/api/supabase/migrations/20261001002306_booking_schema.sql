-- Booking schema for the Voice Agent Sandbox. Fictional demo data only: no real names,
-- emails, phone numbers, addresses or audio are stored.
--
-- The `booking` schema is private. It is NOT added to the Data API's exposed schemas, and
-- anon / authenticated / service_role get no access. Only the FastAPI backend reaches it,
-- through the least-privilege `voice_agent_api` role created in a later migration.
-- Every object is schema-qualified so nothing depends on the session search_path.

set local search_path = pg_catalog, extensions;

create extension if not exists btree_gist with schema extensions;

create schema booking;

comment on schema booking is
  'Private schema for the Voice Agent Sandbox booking demo (fictional data only).';

revoke all on schema booking from public;
revoke all on schema booking from anon, authenticated, service_role;

create table booking.businesses (
  id text primary key check (id ~ '^[a-z0-9-]{1,64}$'),
  name text not null check (name <> ''),
  tagline text not null default '',
  address text not null default '',
  -- Fictional numbers only: the reserved 555-01xx range is enforced.
  phone text not null default '' check (phone = '' or phone ~ '^\+1 [0-9]{3}-555-01[0-9]{2}$'),
  timezone text not null,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  slot_interval_minutes integer not null check (slot_interval_minutes between 5 and 240),
  min_lead_minutes integer not null check (min_lead_minutes >= 0),
  booking_horizon_days integer not null check (booking_horizon_days between 1 and 365),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

create table booking.benches (
  business_id text not null references booking.businesses (id),
  bench_no smallint not null check (bench_no between 1 and 20),
  primary key (business_id, bench_no)
);

create table booking.services (
  business_id text not null references booking.businesses (id),
  id text not null check (id ~ '^[a-z0-9-]{1,64}$'),
  name text not null check (name <> ''),
  description text not null default '',
  duration_minutes integer not null check (duration_minutes between 1 and 720),
  price_amount_minor integer not null check (price_amount_minor >= 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (business_id, id)
);

-- weekday follows Python's date.weekday(): 0 = Monday ... 6 = Sunday. Times are local
-- wall-clock times in the business timezone.
create table booking.opening_hours (
  business_id text not null references booking.businesses (id),
  weekday smallint not null check (weekday between 0 and 6),
  opens_at time not null,
  closes_at time not null,
  primary key (business_id, weekday, opens_at),
  check (opens_at < closes_at)
);

create table booking.appointments (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  business_id text not null,
  service_id text not null,
  bench_no smallint not null,
  -- Half-open [starts_at, ends_at): an appointment ending exactly when another starts does
  -- not overlap it. Stored in UTC (timestamptz); the business timezone is applied only at
  -- presentation boundaries.
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  during tstzrange generated always as (pg_catalog.tstzrange(starts_at, ends_at, '[)')) stored,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  -- A server-generated fictional alias such as "Demo Amber Heron". No free text is accepted.
  customer_alias text not null check (customer_alias ~ '^Demo [A-Z][a-z]+ [A-Z][a-z]+$'),
  -- Privacy-safe, auditable origin of the row. No IP address, user agent or session id.
  source text not null check (source in ('web_demo', 'seed', 'test')),
  -- Idempotency key: one proposal can create at most one appointment. Null for seed rows.
  proposal_id uuid,
  -- A snapshot of what was booked, so the saved record (and a replayed confirmation) never
  -- changes if the catalog does later. The duration is end minus start.
  service_name text not null check (service_name <> ''),
  price_amount_minor integer not null check (price_amount_minor >= 0),
  price_currency char(3) not null check (price_currency ~ '^[A-Z]{3}$'),
  timezone text not null check (timezone <> ''),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint appointments_ends_after_starts check (ends_at > starts_at),
  constraint appointments_proposal_id_key unique (proposal_id),
  constraint appointments_service_fk
    foreign key (business_id, service_id) references booking.services (business_id, id),
  constraint appointments_bench_fk
    foreign key (business_id, bench_no) references booking.benches (business_id, bench_no),
  -- The database itself makes double booking a bench impossible, even for a writer that
  -- skips the application's per-day advisory lock.
  constraint appointments_no_bench_overlap
    exclude using gist (business_id with =, bench_no with =, during with &&)
    where (status = 'confirmed')
);

create index appointments_service_fk_idx on booking.appointments (business_id, service_id);

-- SECURITY INVOKER (not DEFINER) with an empty search_path and only qualified calls.
create function booking.set_updated_at() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

revoke all on function booking.set_updated_at() from public;

create trigger businesses_set_updated_at before update on booking.businesses
  for each row execute function booking.set_updated_at();
create trigger services_set_updated_at before update on booking.services
  for each row execute function booking.set_updated_at();
create trigger appointments_set_updated_at before update on booking.appointments
  for each row execute function booking.set_updated_at();

-- Row Level Security on every table, as defense in depth. With no policy a table denies
-- every non-owner role; the API role's narrow policies are created with the role.
alter table booking.businesses enable row level security;
alter table booking.benches enable row level security;
alter table booking.services enable row level security;
alter table booking.opening_hours enable row level security;
alter table booking.appointments enable row level security;

revoke all on all tables in schema booking from public;
revoke all on all tables in schema booking from anon, authenticated, service_role;
