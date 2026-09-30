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

## Commands

API, run from `apps/api`:

| Task | Command |
| --- | --- |
| Install | `python -m uv sync` |
| Run (reloads on change, http://127.0.0.1:8000, docs at `/docs`) | `python -m uv run fastapi dev src/voice_agent_api/main.py` |
| Format check / apply | `python -m uv run ruff format --check .` / `python -m uv run ruff format .` |
| Lint | `python -m uv run ruff check .` |
| Type check (strict) | `python -m uv run mypy` |
| Test | `python -m uv run pytest` |
| Regenerate `openapi.json` | `python -m uv run python -m voice_agent_api.openapi` |

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

Smoke test with both servers running: `/health`, `/v1/business`, `/v1/services`, and `/v1/services/flat-repair/availability?date=<a Tuesday to Saturday within 14 days>` on port 8000; then `/` and `/?service=flat-repair&date=<same date>` on port 3000. Stop the API and reload the web pages to confirm the unavailable notice appears. Seeded bookings are generated relative to the clock when the API starts, so a server left running for days keeps bookings that are now in the past; restart it to refresh the demo gaps. On Windows, `fastapi dev` leaves its worker process holding the port if only the parent is killed, so stop the whole process tree.

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
