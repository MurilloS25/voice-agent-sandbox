# Development harness

## What is active

- `AGENTS.md` is the canonical cross-agent contract.
- `CLAUDE.md` imports that contract for Claude Code.
- `.claude/skills/frontend-design` is the audited Anthropic skill pinned to its reviewed commit.
- `.claude/agents/product-researcher.md` handles bounded, read-only investigation.
- `.claude/agents/change-reviewer.md` performs a focused, read-only diff review.
- `docs/plans/` and `docs/decisions/` retain durable reasoning without bloating standing instructions.

## Prerequisites

- Node.js 20.9 or newer (22 is what the project was built on) and pnpm.
- Python 3.13 and uv. uv is invoked as `python -m uv` so it does not depend on the `uv` executable being on `PATH`; install it with `python -m pip install uv`.
- Network access on the first `pnpm build`: `next/font` downloads Google Fonts at build time. The first build can fail on a flaky fetch; rerun it.
- Only for the database steps (see "Database and secrets"): a Supabase project you create, the Supabase CLI run as `pnpm dlx supabase@2.119.0` (pinned; no global install and no Docker), and `psql` from an official PostgreSQL client install. `psql --version` must succeed before any password is set; if it does not, stop and install it.

## Commands

API, run from `apps/api`:

| Task | Command |
| --- | --- |
| Install | `python -m uv sync` |
| Run (reloads on change, http://127.0.0.1:8000, docs at `/docs`) | `python -m uv run fastapi dev src/voice_agent_api/main.py` |
| Format check / apply | `python -m uv run ruff format --check .` / `python -m uv run ruff format .` |
| Lint | `python -m uv run ruff check .` |
| Type check (strict) | `python -m uv run mypy` |
| Test (fast, in-memory fakes; database integration tests are excluded) | `python -m uv run pytest` |
| Database integration tests (writes `source = 'test'` rows; needs `apps/api/.env`) | `python -m uv run pytest -m integration` |
| Regenerate `openapi.json` | `python -m uv run python -m voice_agent_api.openapi` |
| Generate local secrets into `apps/api/.env` (names only are printed) | `python -m uv run python -m voice_agent_api.devtools.secrets generate` |
| Validate `.env` (pass or fail per name) / also open one connection | `python -m uv run python -m voice_agent_api.devtools.secrets check` / `check --connect` |
| Reset fictional demo appointments (postgres mode only) | `python -m uv run python -m voice_agent_api.demo_reset` |

Web, run from `apps/web` (copy `.env.example` to `.env.local` only if the API is not at the default address):

| Task | Command |
| --- | --- |
| Install | `pnpm install` |
| Run (http://localhost:3000) | `pnpm dev` |
| Production build / serve | `pnpm build` / `pnpm start` |
| Lint | `pnpm lint` |
| Format check / apply | `pnpm format:check` / `pnpm format` |
| Type check | `pnpm typecheck` |
| Test | `pnpm test` |
| Regenerate API types from `../api/openapi.json` | `pnpm gen:api` |

After changing an API schema: regenerate `openapi.json`, then run `pnpm gen:api`, and commit both. `apps/api/tests/api/test_openapi_contract.py` fails when `openapi.json` is stale.

The API reads `apps/api/.env` (git-ignored; see `apps/api/.env.example`, placeholders only) and the process environment. Without either it runs in memory mode with seed data, which is what the tests and the smoke test below use. `VOICE_AGENT_ENV_FILE` overrides the file path (an empty value disables it). The web app never receives any database setting or the signing key.

Smoke test (memory mode) with both servers running: `/health`, `/v1/business`, `/v1/services`, and `/v1/services/flat-repair/availability?date=<a Tuesday to Saturday within 14 days>` on port 8000; then `/` and `/?service=flat-repair&date=<same date>` on port 3000. Open one of the time links: `/book?service=flat-repair&start=<slot start>` must show the review and save nothing until **Confirm booking** is pressed, and confirming must land on `/appointments/<id>`. Stop the API and reload the web pages to confirm the unavailable notice appears, including on confirm. Seeded bookings are generated relative to the clock when the API starts, so a server left running for days keeps bookings that are now in the past; restart it to refresh the demo gaps. On Windows, `fastapi dev` leaves its worker process holding the port if only the parent is killed, so stop the whole process tree.

## Database and secrets

Everything here changes a remote project or creates a secret, so each step waits for explicit approval. Run Supabase CLI commands from `apps/api`. The migrations are in `apps/api/supabase/migrations/`, created by `supabase migration new` so the CLI chose the timestamped names; do not rename or invent files by hand.

| Step | Command | Effect |
| --- | --- | --- |
| Link (local config only) | `pnpm dlx supabase@2.119.0 link --project-ref <ref>` | Prompts for the postgres password. Never pass it as a flag. |
| Read-only checks | `pnpm dlx supabase@2.119.0 migration list`, `psql --version` | None. Also check `select version()` and that `btree_gist` is available. |
| Preview, then apply | `pnpm dlx supabase@2.119.0 db push --dry-run`, then `db push` | **Remote mutation.** |
| Advisors | `pnpm dlx supabase@2.119.0 db advisors --type security`, then `--type performance` | Read-only. Expect no ERROR or WARN for `booking.*`. |
| Generate secrets | `python -m uv run python -m voice_agent_api.devtools.secrets generate` | Creates `apps/api/.env` locally. |
| Set the role password | In `psql` as `postgres.<ref>` on the session pooler: `\password voice_agent_api`, paste `DB_PASSWORD` from `.env` at the hidden prompt, then `alter role voice_agent_api login;` | **Remote mutation.** Never use the Supabase SQL Editor for passwords. |
| Check connectivity | `python -m uv run python -m voice_agent_api.devtools.secrets check --connect` | Prints pass or fail only. |

Fill the non-secret `DB_HOST`, `DB_USER` (`voice_agent_api.<project_ref>`) and `DB_SSLROOTCERT` (the CA certificate from the dashboard) in `.env`, then set `APPOINTMENT_STORE=postgres`.

Rotation or suspected leak: `secrets generate --rotate`, run `\password voice_agent_api` again with the new `DB_PASSWORD`, and restart the API. The old password stops working immediately. A rotated signing key invalidates reviews that are open (they last 10 minutes).

After `db push`, these queries should return nothing for the first and `false, false, false, true, false, false` for the second (the same checks run in `tests/integration`):

```sql
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'booking' and c.relkind = 'r' and not c.relrowsecurity;
select has_schema_privilege('anon', 'booking', 'usage'),
       has_schema_privilege('authenticated', 'booking', 'usage'),
       has_schema_privilege('service_role', 'booking', 'usage'),
       has_table_privilege('voice_agent_api', 'booking.appointments', 'select'),
       has_table_privilege('voice_agent_api', 'booking.appointments', 'update'),
       has_table_privilege('voice_agent_api', 'booking.services', 'insert');
```

### Secret scan (run before every commit that touches configuration, and in the final review)

No command here opens a `.env` file. Any hit other than a placeholder fails the review.

```text
git ls-files | rg "(^|/)\.env($|\.)"        # expect only the two .env.example files
git check-ignore -v apps/api/.env             # expect the .gitignore rule
git grep --untracked -nEI "sb_secret_|SCRAM-SHA-256\$|postgres(ql)?://[^[:space:]:@]+:[^[:space:]@]+@|(PASSWORD|SIGNING_KEY|SECRET|TOKEN)[A-Z_]*[[:space:]]*[=:][[:space:]]*['\"]?[A-Za-z0-9_-]{20,}" -- . ":!*.lock" ":!pnpm-lock.yaml" ":!apps/web/src/lib/api/schema.d.ts" ":!docs/HARNESS.md"
git diff main...HEAD | rg -n "sb_secret_|SCRAM-SHA-256|postgres(ql)?://[^ :@]+:[^ @]+@"
git status --ignored --short                  # apps/api/.env appears only as ignored
```

## Normal loop

1. Ask the main agent to inspect the requested area and state a bounded outcome.
2. Delegate uncertain external research to `product-researcher` when it would otherwise flood the main context.
3. Create a plan only for multi-boundary or risky work.
4. Implement one vertical slice.
5. Run the checks listed under Commands, narrow ones first.
6. Use `change-reviewer` before committing meaningful changes.
7. Record only decisions expected to outlive the current task.

## Claude Code built-ins

After updating Claude Code, prefer its bundled `/run`, `/verify`, `/code-review`, `/debug`, and `/security-review` workflows. The project can now launch; run `/run-skill-generator` so the startup recipe is recorded by the tool instead of maintained by hand here.

## Deliberately absent

- No MCP server: the initial implementation needs ordinary APIs and local tools.
- No hooks: the commands above now exist, but nothing has yet shown that a hook would catch something the normal loop misses. Add one only for a specific recurring failure.
- No blanket tool approvals: each potentially mutating operation should retain normal permission checks.
- No agent team: two focused read-only subagents are enough for the current project size.

## Maintenance

Whenever scaffolding changes how the system installs, runs, tests, or validates, update this file. Remove harness elements that are not earning their context or maintenance cost.
