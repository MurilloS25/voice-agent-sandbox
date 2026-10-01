# The catalog lives in PostgreSQL and changes only through Supabase CLI migrations

- Status: accepted
- Date: 2026-09-30

## Context

Appointments need real foreign keys to a business, its services and its benches, and a catalog change must be detectable between a review and its confirmation. Milestone 1 held the catalog in code. The project does not use Docker, so the local Supabase stack, `db diff`, `db pull` and a local `db reset` are unavailable.

## Decision

- The fictional business, benches, services and opening hours are tables in the private `booking` schema, seeded by a migration. Appointments reference them through composite foreign keys, so a service cannot be deleted while appointments use it.
- Schema changes are versioned SQL files in `apps/api/supabase/migrations/`, created with `supabase migration new` so the CLI assigns the timestamped filenames, and applied to a linked project with `supabase db push` (after `--dry-run`). No filename is invented by hand. The CLI version is pinned in `docs/HARNESS.md`.
- The catalog is **read from the database on every request**, with no startup cache, so a change is visible immediately and feeds the proposal fingerprint (ADR 0004). Startup performs one sanity read only.
- `infrastructure/seed.py` stays as the in-memory catalog and the source of the demo bookings. An integration test compares the database catalog with it field for field, and an offline test checks the seed migration text, so the two cannot drift silently.
- Appointments copy what they need to describe themselves (service name, price, currency, business timezone) at booking time, so a saved record never changes when the catalog does. The foreign keys still stop a service or bench from being deleted while appointments use it.
- Benches must be numbered 1..N: `free_bench` allocates the lowest free number, so the adapter refuses a catalog whose highest bench number differs from the bench count rather than mis-allocating.
- Demo data reset: `python -m voice_agent_api.demo_reset` deletes rows whose `source` is `seed` or `web_demo` and reseeds bookings relative to now. Test rows (`source = 'test'`) are removed by the test fixtures.
- Each migration begins with `set local search_path = pg_catalog, extensions;` and schema-qualifies every object. No migration contains a password or any other secret.

## Consequences

- The catalog costs a couple of small queries per request. A short-TTL cache is a straightforward later optimization if it matters.
- Migrations cannot be run or diffed locally, so they are proven only by `db push` plus the integration tests against a development project. Offline tests guard the textual rules and a Postgres-parser syntax check was run once.
- `seed.py` and the seed migration are two sources for the same data until the parity tests are the only thing keeping them aligned.

## Alternatives considered

- **Appointments only, catalog in code:** the smallest slice, but no foreign keys and no way to detect catalog changes server-side.
- **A local Supabase stack for migration testing:** needs Docker, which this project does not use.
- **ORM-managed migrations:** duplicate the Supabase migration workflow.
