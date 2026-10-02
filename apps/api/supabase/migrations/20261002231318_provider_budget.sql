-- Daily provider budget (plan 0007, decision D5).
--
-- One row per UTC day and category holds only aggregate numbers: how much of the provider's
-- allowance the backend has used and the limit that applied. It never holds a visitor
-- identifier, an address or a hash of one, text, audio, a transcript or any provider metadata.
--
-- The backend reserves an amount here BEFORE calling the provider and settles the difference
-- afterwards. The reservation is a single atomic statement (see `PostgresBudgetLedger`), so
-- concurrent requests cannot overspend. If the budget cannot be checked, the backend refuses to
-- call the provider (it fails closed).
--
-- This migration only adds. To remove the table later, add a new migration; nothing here
-- is dropped automatically and no deployment step runs a destructive statement.

set local search_path = pg_catalog, extensions;

create table booking.provider_budget (
  day_utc date not null,
  category text not null check (category in ('agent_tokens', 'speech_seconds')),
  -- Aggregate use. Settling real usage can add more than was reserved, so this may pass
  -- `limit_amount` by one call's overshoot; reservations never do.
  consumed bigint not null default 0 check (consumed >= 0),
  limit_amount bigint not null check (limit_amount >= 0),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (day_utc, category)
);

comment on table booking.provider_budget is
  'Aggregate daily provider usage by category (UTC). Numbers only: no visitor data of any kind.';

alter table booking.provider_budget enable row level security;

revoke all on booking.provider_budget from public;
revoke all on booking.provider_budget from anon, authenticated, service_role;

-- Only the application's role, and only the columns it must change. No delete: a day's row is
-- history, not state to be removed by the API.
grant select, insert on booking.provider_budget to voice_agent_api;
grant update (consumed, limit_amount, updated_at) on booking.provider_budget to voice_agent_api;

-- Policies are scoped to this role only; the other roles have none (and no privileges).
create policy provider_budget_api_select on booking.provider_budget
  for select to voice_agent_api using (true);
create policy provider_budget_api_insert on booking.provider_budget
  for insert to voice_agent_api with check (true);
create policy provider_budget_api_update on booking.provider_budget
  for update to voice_agent_api using (true) with check (true);
