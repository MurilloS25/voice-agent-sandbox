# Outcome

A FastAPI backend serves a fictional bicycle workshop (Quillwheel Cycle Works) with deterministic availability, and a Next.js page shows the business, its services, and a read-only availability lookup. Nothing can be booked yet.

## Scope

Included:

- `apps/api`: health, business, services, and availability endpoints; typed Pydantic schemas; a structured error envelope; a framework-free domain; an in-memory adapter seeded with fictional data.
- `apps/web`: one page with the overview, the services and prices, the opening hours, and an availability lookup driven by URL search params. Loading, empty, unavailable, and error states. Prices formatted with `Intl.NumberFormat` from the API's currency.
- Tooling: Ruff, mypy (strict), pytest, ESLint, Prettier, `tsc`, Vitest with Testing Library.

Excluded: voice, LLM/LangGraph, any database, authentication, appointment mutations, CORS, CI, Docker, hooks, MCP, browser E2E tests, deployment.

## Approach

1. **Domain** (`apps/api/src/voice_agent_api/domain`): frozen dataclasses, pure availability functions with an injected `now`, and two small ports (`BusinessCatalog`, `AppointmentBook`) that the in-memory adapters implement.
2. **Transport** (`.../api`): routes, response schemas, dependency wiring through `app.state`, and exception handlers that return `{"error": {"code", "message", "details?"}}`.
3. **Contract**: `apps/api/openapi.json` is committed and checked by a drift test. `apps/web/src/lib/api/schema.d.ts` is generated from it (see `docs/decisions/0001-openapi-as-contract-source.md`).
4. **Web**: Server Components call the API server-side with `API_BASE_URL`, so the browser never contacts the API and no CORS is needed. The lookup is a GET form; results stream inside a `Suspense` boundary keyed by the selection.

Fictional business rules: `America/New_York`, USD, Tuesday to Friday 09:00 to 13:00 and 14:00 to 18:00, Saturday 09:00 to 14:00, closed Sunday and Monday, two benches, 30-minute slot grid, two hours of lead time, a 14-day booking window. Times are UTC on the wire and converted only for display.

DST rule: a local slot start that does not exist is skipped, and an ambiguous local time resolves to its first occurrence, so no slot is invented or duplicated.

## Verification

API, from `apps/api`:

```text
python -m uv sync
python -m uv run ruff format --check .
python -m uv run ruff check .
python -m uv run mypy
python -m uv run pytest
```

Web, from `apps/web`:

```text
pnpm install
pnpm gen:api            # then confirm git shows no change to src/lib/api/schema.d.ts
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

Smoke test: start `python -m uv run fastapi dev src/voice_agent_api/main.py` and `pnpm start`, request the endpoints and pages listed in `docs/HARNESS.md`, then stop the API and confirm the pages show the unavailable notice instead of failing.

## Decisions or follow-ups

Recorded: `docs/decisions/0001-openapi-as-contract-source.md`.

Deferred:

- Request IDs and structured logging.
- CORS, once the browser calls the API directly.
- Playwright end-to-end tests and CI.
- A database adapter behind the same ports.
- Appointment mutations with explicit confirmation and idempotency.
- The chat and agent-turn endpoint, voice, LLM/LangGraph, and authentication.
