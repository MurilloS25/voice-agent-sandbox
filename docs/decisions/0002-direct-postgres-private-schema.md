# The API reaches PostgreSQL directly, in a private schema, as a least-privilege role

- Status: accepted
- Date: 2026-09-30

## Context

Milestone 2 persists appointments in Supabase PostgreSQL. The only client is the FastAPI backend; the browser never talks to the database, and there is no authentication yet. Booking needs multi-statement transactions, an advisory lock and SQLSTATE-level error handling. Supabase also exposes tables to its Data API (PostgREST) when they live in an exposed schema, and from 2026-10-30 new `public` tables stop being granted to the Data API roles automatically.

psycopg's pool is synchronous, and async psycopg does not work with Windows' default event loop, which is this project's development platform.

## Decision

- FastAPI connects straight to PostgreSQL with psycopg 3 and a synchronous `ConnectionPool`, through Supabase's session pooler (port 5432), with `sslmode=verify-full` and `prepare_threshold=None`. There is no supabase-py, no Data API and no Supabase API key anywhere.
- Tables live in a private `booking` schema that is not added to the Data API's exposed schemas. `anon`, `authenticated`, `service_role` and `PUBLIC` have no privileges on it. Row Level Security is enabled on every table anyway, with policies only for the API role.
- The API connects as `voice_agent_api`: no superuser, no `BYPASSRLS`, `SELECT` on the five tables, `INSERT` and `DELETE` on `appointments` (delete only for `demo_reset` and test cleanup). It never connects as `postgres`. There are no `SECURITY DEFINER` functions and no use of `user_metadata`.
- **Blocking I/O rule.** Every call that can touch the database runs in FastAPI's worker threadpool: routes and dependencies that reach a port are plain `def`, and the lifespan opens and closes the pool through `run_in_threadpool`. A test enforces that no `async def` route or dependency calls a port, and a measured test shows concurrent requests are not serialized.
- **Timeout budget.** libpq `connect_timeout` 3 s, TCP `tcp_user_timeout` 5 s plus keepalives, pool acquire 2 s, a bounded wait queue of 20, and `statement_timeout` 1 s, `lock_timeout` 1 s and `idle_in_transaction_session_timeout` 5 s. The statement and lock limits are set per transaction and also as role-level defaults, which is what bounds the very first statement of a transaction (the `set_config` preamble) before the per-transaction values take effect.
  - `statement_timeout` is **per statement**, not per transaction, so the worst case for a slow but answering database is the pool acquire plus one statement limit for every statement, counting the preamble and the commit: **7 s** for availability and proposals (one transaction of 3 queries, via `day_view`) and **10 s** for confirm (6 queries plus the lock). A silent network failure is bounded by the 5 s TCP limit instead.
  - The web client allows 12 s for reads and 15 s for writes: the worst case plus about 2 s for Node, rendering and the network, plus 3 s of slack. `tests/test_timeout_budget.py` recomputes this from the real defaults and fails if either side changes without the other.
  - The rare `proposal_id` unique-violation backstop runs one more transaction (about 5 s more). It is only reachable if two requests for the same proposal ran past the day lock, so it is not budgeted.
- Every runtime statement is a parameterized `LiteralString` constant, every table and function is schema-qualified, and every transaction pins `search_path` to `pg_catalog, pg_temp` instead of inheriting the connection default.
- psycopg errors never escape the adapter unmapped. Connection, pool, statement and lock timeouts become one fixed `storage_unavailable` error that carries no SQL, DSN or parameters.

## Consequences

- A single, small trust path: browser → Next.js server → FastAPI → PostgreSQL. No database credential can reach the browser.
- The synchronous pool needs the threadpool discipline above, and the pool size (default 5) must stay below the threadpool's limit.
- Direct connections are IPv6-only without a paid add-on, so this uses the IPv4 session pooler. Moving to serverless hosting would mean switching to transaction mode, which is why prepared statements are already disabled.
- The database is only exercised end to end after a Supabase project exists. Until then the adapter is covered by offline tests with a scripted fake pool.

## Alternatives considered

- **supabase-py / PostgREST:** HTTP only, no multi-statement transactions without moving logic into RPC functions, and it forces an exposed schema plus grants.
- **SQLAlchemy 2.x:** valid, but about a dozen hand-written statements do not justify an ORM, and Alembic would duplicate Supabase migrations.
- **Async psycopg:** fails on Windows' default event loop.
- **An exposed `public` schema with RLS:** workable, but it widens the attack surface for no benefit when only the backend connects.
