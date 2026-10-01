-- Least-privilege role for the FastAPI backend.
--
-- The role is created NOLOGIN with NO password. A password is never written in a migration:
-- it is set once, interactively, with psql's \password (which sends a hash, not the cleartext),
-- and only then is LOGIN granted. Until then nothing can connect as this role.

set local search_path = pg_catalog, extensions;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'voice_agent_api') then
    create role voice_agent_api nologin noinherit nobypassrls nosuperuser nocreatedb nocreaterole;
  end if;
end
$$;

-- The same limits the application sets per transaction. They also cover the one statement
-- that runs before the application's own settings take effect (its first, `set_config`).
alter role voice_agent_api set search_path = pg_catalog, pg_temp;
alter role voice_agent_api set statement_timeout = '1s';
alter role voice_agent_api set lock_timeout = '1s';
alter role voice_agent_api set idle_in_transaction_session_timeout = '5s';

grant usage on schema booking to voice_agent_api;

grant select on booking.businesses, booking.benches, booking.services, booking.opening_hours,
  booking.appointments to voice_agent_api;
-- Delete exists only for `demo_reset` and test cleanup. No HTTP route deletes.
grant insert, delete on booking.appointments to voice_agent_api;

-- Policies are scoped to this role only. anon and authenticated have none, so even if a
-- grant were added by mistake they would see no rows.
create policy businesses_api_select on booking.businesses
  for select to voice_agent_api using (true);
create policy benches_api_select on booking.benches
  for select to voice_agent_api using (true);
create policy services_api_select on booking.services
  for select to voice_agent_api using (true);
create policy opening_hours_api_select on booking.opening_hours
  for select to voice_agent_api using (true);

create policy appointments_api_select on booking.appointments
  for select to voice_agent_api using (true);
create policy appointments_api_insert on booking.appointments
  for insert to voice_agent_api with check (status = 'confirmed');
create policy appointments_api_delete on booking.appointments
  for delete to voice_agent_api using (source in ('web_demo', 'seed', 'test'));
