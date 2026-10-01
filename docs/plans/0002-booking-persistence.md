# Outcome

A visitor picks an open slot, sees a review of exactly what will be booked, and presses **Confirm booking**. They then see an appointment that is persisted in Supabase PostgreSQL. Double booking is impossible even under concurrent requests, retries never create duplicates, a slot taken or a service changed in the meantime produces a clear conflict state, and an unreachable or slow database produces a bounded, generic "unavailable" state rather than a hung request.

**Status.** The provider-free slice is implemented and verified in memory: domain, signed proposals, fingerprint and stale detection, API, web, tests, migrations (syntax-checked, not executed) and the PostgreSQL adapter (exercised offline with a scripted fake pool). The steps that need a real Supabase project are gated (see Gates) and have not run. Nothing has been applied to any remote project.

## Scope

Included:

- Bench-aware availability (`free_bench`, `check_slot`) replacing the peak-concurrency rule.
- `propose_appointment` (no write) and `confirm_appointment` (the only write), with idempotency keyed by proposal id.
- A signed proposal token `{v, pid, svc, start, exp, fp}` and a catalog/review fingerprint with a `proposal_stale` conflict.
- A PostgreSQL catalog and appointment adapter using psycopg 3's synchronous pool, always run in the worker threadpool, with connect, pool, statement, lock and idle timeouts.
- Validated settings with secret handling, a secrets devtool (`generate`, `check`) and a `demo_reset` command.
- Supabase CLI migrations: a private `booking` schema with RLS on every table, a least-privilege `voice_agent_api` role, and the fictional catalog seed.
- Endpoints: `POST /v1/appointment-proposals`, `POST /v1/appointments`, `GET /v1/appointments/{id}`.
- Web: slot links, the review page, the confirm form (pending, conflict, stale, expired, invalid, unavailable, error), the confirmation page, and fictional-demo labelling.
- Tests across domain, API, concurrency, idempotency, event-loop behavior, SQL hardening, secrets, OpenAPI drift, web and accessibility, plus database integration tests.
- ADRs 0002 to 0006.

Excluded: LLM, LangGraph, voice, authentication, reschedule, cancel (the `cancelled` status exists but nothing writes it), deployment, CI, Docker, Playwright, rate limiting, retention jobs, automated key rotation, the Supabase Data API and supabase-py.

## Approach

1. **Domain** (`apps/api/src/voice_agent_api/domain`): `free_bench`, `local_day_bounds` and `check_slot` in `availability.py`; `commands.py` (propose, confirm, with `decide` running inside the adapter's locked transaction); `fingerprint.py`; `aliases.py`; new errors; ports gain `snapshot`, `confirm` and `get`.
2. **Adapters** (`infrastructure`): in-memory (one lock, same port semantics) and `postgres.py` (parameterized `LiteralString` statements, schema-qualified, `search_path` pinned per transaction, advisory lock keyed by business and local day, explicit rollback and error map, nothing from psycopg escapes unmapped).
3. **Transport** (`api`): strict token codec (`proposal_tokens.py`), schemas, plain-`def` routes and dependencies, domain-error handlers in the existing envelope, a `factory.py` with a lifespan that opens and closes the pool through the threadpool. `main.py` is only the entrypoint that reads settings.
4. **Database** (`apps/api/supabase/migrations`, created by the CLI): `booking_schema`, `booking_catalog_seed`, `booking_api_role`.
5. **Contract**: `openapi.json` regenerated, `schema.d.ts` regenerated, both committed.
6. **Web**: `client.ts` is `server-only` and gains `createProposal`, `confirmAppointment` and `getAppointment`; the Server Action `confirmBooking` maps API results to a small state object and redirects on success.

Timeout budget: `statement_timeout` is per statement, so the worst case for a slow but answering database is pool acquire (2 s) plus 1 s for each statement including the preamble and the commit: 7 s for availability and proposals (one `day_view` transaction) and 10 s for confirm. A silent network failure is capped by a 5 s TCP timeout. Web client: reads 12 s, writes 15 s (worst case plus about 2 s overhead plus 3 s slack); `tests/test_timeout_budget.py` keeps the two sides consistent. A timeout on confirm is an unknown outcome, so the UI offers a retry of the same token, which is safe because confirming is idempotent. An unrecognised response (5xx, unreadable body) is treated the same way, and only a known 4xx refusal is reported as "nothing was booked".

## Gates

Everything below needs the user and stops for approval before any external effect.

| Gate | Step | Status |
| --- | --- | --- |
| G1 | User creates a new Free-plan Supabase project and stores the postgres password in a password manager. | Pending |
| G2 | User runs `supabase login`; `supabase link --project-ref <ref>` from `apps/api` (local config only). | Pending |
| G3 | Read-only checks: `btree_gist` is available, `select version()`, `supabase migration list`, `supabase db advisors --help`, `psql --version`. | Pending. **`psql` is not installed on the development machine.** |
| G4 | `supabase db push --dry-run`, user reviews, then `supabase db push` (a remote mutation). | Pending |
| G5-pre | `psql --version` must succeed. If not, stop: install an official PostgreSQL client or approve another documented method. No automatic fallback. | **Blocked on psql** |
| G5a | `secrets generate` creates `apps/api/.env` (local, secret files). | Pending |
| G5b | User runs `\password voice_agent_api` in psql, then `alter role voice_agent_api login;`. | Pending |
| G5c | `secrets check --connect`. | Pending |
| G6 | `pytest -m integration` writes and deletes `source = 'test'` rows remotely. | Pending |
| G7 | `demo_reset` against the remote project; optionally enable SSL enforcement (reboots the database). | Pending |

Not verified until the gates run: that `btree_gist` can be installed, that `create role` and `alter role … set …` work inside a pushed migration, that `lock_timeout` bounds an advisory-lock wait, the advisor results, and that the migrations execute at all.

## Verification

Run, and passing on this branch (counts from the last run):

```text
# apps/api
python -m uv run ruff format --check .
python -m uv run ruff check .
python -m uv run mypy
python -m uv run pytest                       # 292 passed, 15 integration tests deselected
python -m uv run python -m voice_agent_api.openapi   # then: git diff --exit-code openapi.json

# apps/web
pnpm gen:api            # no change to src/lib/api/schema.d.ts afterwards
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test               # 145 passed
pnpm build
```

Also run: an end-to-end smoke test against the real API (memory mode) and the production web build, driving the real Server Action through the form's progressive-enhancement POST. It covered: review writes nothing, confirm redirects to a persisted appointment, a repeated confirm returns the same appointment, a third confirm of a full two-bench slot shows the conflict, malformed and missing selections, an unknown appointment, a tampered token (not booked), and the unavailable notice with the API stopped. That run found and fixed a crash on a malformed `start` value.

Reviewed: a read-only review of the whole diff (confirmation integrity, privacy, concurrency, contract) found no blockers. It found, and this change fixed: a replayed or re-read appointment showing catalog values that were never saved (appointments now store a snapshot of the booked service name, price and timezone, and the response is rendered from that row alone), a `slot_not_offered` confirm shown as a retryable error, a "not confirmed" claim for outcomes that are really unknown, a post-commit catalog read that could turn a successful booking into a 5xx, a wrong timeout budget (see above), missing TCP-level connection timeouts, `/book` making three API calls per view, `.env` files created world-readable, a loose fictional-phone check, and benches numbered with gaps. It also showed that app logging was never configured when run under uvicorn, and that the audit log recorded a submitted id; both are fixed and tested.

Not run (gated): `supabase db push`, the integration suite (`python -m uv run pytest -m integration`), `supabase db advisors --type security|performance`, the post-migration queries in `docs/HARNESS.md`.

## Decisions or follow-ups

Recorded: ADRs 0002 (direct Postgres, private schema, threadpool and timeouts), 0003 (one bench per appointment), 0004 (signed proposals and stale detection), 0005 (catalog in Postgres via CLI migrations), 0006 (secret provisioning and validation).

Deferred:

- Cancel and reschedule.
- Retention and cleanup of test or demo rows (pg_cron).
- Rate limiting, required before any public deployment.
- Automated signing-key rotation (a manual runbook exists).
- Transaction-mode pooling for serverless hosting.
- Playwright end-to-end tests and CI.
- A short-TTL catalog cache, if per-request catalog reads ever matter.
- Persisted tool-event timeline, and an agent tool that proposes but never confirms.

## Manual browser review (not yet done)

A scripted browser was not available, so these were checked only through jsdom tests and an end-to-end HTTP smoke test that drives the real Server Action without JavaScript. Please run them by hand in Chrome with both servers running in memory mode (`/book?service=flat-repair&start=<slot start>` is reachable from any time link on `/`):

- **Flow, JavaScript on:** pick a service and date, click a time, check the review (service, date, time, duration, time zone, price, "Name on booking (fictional)", "Nothing has been booked yet", the demo banner), click **Confirm booking**, and land on `/appointments/<id>` with focus on the "Booked: …" heading.
- **Double click** on Confirm booking: one appointment only; the button shows "Confirming…" and is disabled.
- **Refresh and back:** refresh the review (a new review, no booking); after confirming, press Back and Confirm again (same appointment, no second booking); refresh the appointment page (same content).
- **Conflict:** open the same review in two tabs after the slot has one bench left, confirm in both: the second shows "That time was just taken", no retry button, and the alert takes focus. (Booking a slot twice yourself uses both benches by design.)
- **Unavailable and retry:** stop the API, click Confirm: "The schedule service isn't responding … confirming the same review twice never books twice", with **Try again**; restart the API and press Try again.
- **Expired, stale, tampered, not offered:** these need a forged or old token, so use the smoke test, or wait 10 minutes on an open review for "expired".
- **Keyboard:** Tab reaches the time links, then Confirm booking, then the links in any message; Enter or Space activates; the focus ring is visible; after a message appears focus is on the message.
- **Layout:** at 1440 px, 390 px and 320 px wide, and at 200% text size (browser zoom or "text only"), check that nothing overflows horizontally, the details list stays readable, the Confirm button stays at least 48 px tall, and long names wrap.
