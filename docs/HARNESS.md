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
| Build the API image (context = repository root) | `docker build -f apps/api/Dockerfile -t voice-agent-api .` |
| Reset fictional demo appointments (postgres mode only) | `python -m uv run python -m voice_agent_api.demo_reset` |

Local development needs `APP_ENV=development` and `API_AUTH_MODE=disabled` (the shipped `apps/api/.env.example` sets both): the default environment is **production**, which requires `API_SHARED_SECRET` and refuses unsafe settings. `apps/api/.env.production.example` and `apps/web/.env.production.example` list the production variables by name only.

Production-mode check with Docker (no network, fake values, nothing real): `docker run -d --network none -e API_SHARED_SECRET=<32+ fake chars> -e PROPOSAL_SIGNING_KEY=<fake base64url of 32 random bytes> -e APPOINTMENT_STORE=memory voice-agent-api`, then probe `/health/live` and `/health/ready` with `docker exec`. Without those variables the container exits 1 naming only the failed setting. Verified at G3 on Docker 29.6.1.

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

Agent tests (`tests/agent`, `tests/api/test_agent_turns.py`, `tests/evals`) run in the default `pytest`. They use a scripted chat model and need no network, no provider key and no `apps/api/.env`; the agent tests block non-loopback sockets and disable LangSmith tracing. They replay the scenarios in `evals/agent/scenarios` ([evals/README.md](../evals/README.md)). Provider-backed checks (marker `provider`) are described below and never run by default.

The model provider is off by default (`AGENT_PROVIDER=disabled`): with it off, the API and `secrets check` need no key and no model, and `POST /v1/agent/turns` answers 503. To enable it later, put `AGENT_PROVIDER=groq`, `GROQ_API_KEY` and `AGENT_MODEL` in your own git-ignored `apps/api/.env` by hand (the model comes from [ADR 0008](decisions/0008-model-provider-adapter-and-selection.md)); a selected provider with a missing or placeholder value fails startup and `secrets check`, naming only the setting. `secrets generate` never writes provider values. Live provider evaluation (`tests/evals/test_live_scenarios.py`, marker `provider`) is deselected by default and skips unless `RUN_LIVE_PROVIDER_EVALS=1`. Run it deliberately from `apps/api` with `RUN_LIVE_PROVIDER_EVALS=1 python -m uv run pytest -m provider tests/evals/test_live_scenarios.py -s`. It reads the key only through `Settings`, forces `APPOINTMENT_STORE=memory`, never retries, paces itself to a 7,000 tokens per minute target (the final run peaked at 7,223, a documented deviation below the provider's 8,000 limit) and a daily token ceiling, stops on any provider failure, and prints only sanitized results (scenario ids, pass/fail, criteria labels, tool names, event kinds, counts, tokens, latencies). Its offline tests (`tests/evals/test_live_harness.py`) run in the default `pytest`. The endpoint is pinned to `https://api.groq.com` (environment overrides are ignored), and startup fails if LangSmith tracing is enabled in the environment (`LANGSMITH_TRACING`, `LANGCHAIN_TRACING_V2`). The provider tests run in the default `pytest` against a mock HTTP transport and make no network request. In `tests/evals/test_live_scenarios.py`, `PRIOR_TOKENS` holds the cumulative usage (151,528 tokens, counting the final model-selection run and the browser check), while `DAILY_CEILING` (175,000) and the primary-model-only loop are those of the final attempt: after any new live run add its usage to `PRIOR_TOKENS`, and before one review the ceiling and the model list.

Voice (plan 0004, [ADR 0009](decisions/0009-voice-input-and-spoken-output.md)). The speech tests (`tests/speech`, plus the speech cases in `tests/test_config.py`, `tests/test_secrets_devtool.py` and `tests/api/test_event_loop.py`) run in the default `pytest`: no network, no key, no `apps/api/.env`, no provider call, audio generated in memory with the stdlib `wave` module (no human voice is versioned), and non-loopback sockets blocked. Settings (all optional; `.env.example` holds placeholders only): `APP_ENV` (`development`, `test` or `production`, default `production`), `SPEECH_PROVIDER` (`disabled` by default, `fake`, `groq`), `SPEECH_MODEL` (no default, never in code; required for `groq`, which also reuses `GROQ_API_KEY`), `SPEECH_TIMEOUT_S` (default 6), `SPEECH_READ_TIMEOUT_S` (3), `SPEECH_MAX_AUDIO_BYTES` (524288) and `SPEECH_MAX_CONCURRENT` (2). The three timeout and size settings can only be lowered: their upper bounds are the plan's budget, which keeps a request inside the web client's 14 s (`SPEECH_TIMEOUT_MS`, pinned against the API's limits by `tests/speech/test_budget.py`); concurrency is capped at 4. `SPEECH_PROVIDER=fake` is accepted only with `APP_ENV` explicitly `development` or `test`, and returns a fixed fictional transcript: use it to try `/assistant` without a provider (set both for the API process only). `secrets check` prints names and pass or fail for the speech settings; `secrets generate` never writes them. The web side adds `src/app/api/voice/transcribe/route.ts` (same-origin route handler) and its tests with the capture, synthesis and component tests under `pnpm test`.

Voice browser rehearsal (offline; done for Milestone 4, repeat after changes to capture, the route handler or the transcript flow; no real provider and no human voice; the same flow was later run once against the real services, below): keep a small script **outside the repository** that builds the app with `create_app(..., agent=AgentService(model=ScriptedChatModel(...), ...), speech=SpeechService(ScriptedSpeechToText()))` on a free loopback port, with `VOICE_AGENT_ENV_FILE` empty and non-loopback sockets blocked; run `pnpm build` then `pnpm exec next start -p <port>` in `apps/web` with `API_BASE_URL` pointing at it; and drive headless Edge or Chromium over the DevTools protocol with a throwaway profile, `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<a synthetic tone WAV generated for the run>` and an injected stub `speechSynthesis` that records what is spoken (headless browsers may have no voices). Check: no microphone request on load, Speak then Stop puts the transcript in the box with focus and sends nothing, the edited text sends, Listen speaks only the reply text, the proposal token is never spoken or visible, **Confirm booking** (unchanged) creates one appointment and a replay creates none, a cancelled recording uploads nothing, reduced motion removes the animation, no horizontal scroll at 1440, 390 and 320 px and at 200% text, axe clean, no console errors, and no request to any host other than loopback. Afterwards stop every process, delete the profile and the WAV, and confirm no listener remains.

Voice-first rehearsal (plan 0006, same rules: scripts and screenshots outside the repository, loopback only, throwaway profile, no provider). On top of the setup above: a scripted model that answers by keyword (so a booking review can be produced) and a scripted speech-to-text on one API port; a second API with the agent switched off (`agent_unavailable`) and a third with speech switched off, each behind its own `next start`; a stub `speechSynthesis` injected with `Page.addScriptToEvaluateOnNewDocument` that records what is spoken, fires `start` and `end`, and can expose no voice, only a local and a network voice, or no API at all; init scripts that remove `mediaDevices` or reject `getUserMedia` with `NotAllowedError`. Use `Page.setFontSizes` (`standard` 32) for a real 200% text size (it scales rem and the rem media queries together, unlike overriding `html { font-size }`). Check at 1440, 390 and 320 px, 200% text and 720x450 (zoom 2x): Start speaks the welcome and sends nothing, Tap to speak, Stop, the editable review, Send what I said, the reply read once, Stop speaking, End voice session, Voice and Text over one conversation, the transcript, activity and settings panels (focus in, focus back), the booking review with the one **Confirm booking**, `agent_unavailable`, no microphone, permission denied, speech off, no voices, no horizontal overflow, no page scroll at normal text size, controls inside the viewport, axe, no console messages and only loopback requests. Plan 0006's follow-up adds: counters injected for `AudioContext` creation and closing and for live animation frames (so cleanup can be asserted), a `fetch` wrapper that delays the transcription and the turn (so Transcribing and Thinking can be observed and the visitor can leave during them), `Emulation.setEmulatedMedia` for reduced motion, and a local plus a network stub voice (record which voice spoke). The rehearsal for plan 0006 found one real defect before review: `sr-only` elements inside a scrolling container escaped it (no positioned ancestor) and made the document scroll, fixed by making the shell and each scroll container `relative`.

Voice against a real provider is **not** part of the offline work, and each step needs its own approval. For Milestone 4 all three were done once (2026-10-01): C1 (documentation and local configuration only, no request: Zero Data Retention confirmed by the operator, the model listed as Production and not deprecated, the documented limits, `secrets check` and the effective settings with every network path blocked), C2 (one live transcription of a synthetic clip made with a local Windows voice, through the app's real route: 1 request, HTTP 200, 10 billed audio-seconds) and C3 (one end-to-end session in headless Edge with a fake microphone device fed by a synthetic clip, the real transcription and the real agent, then the existing **Confirm booking**: 1 transcription request, 4 chat requests, 10 billed audio-seconds, 6,264 agent tokens). Repeating any of them needs a new approval. How they were run, so a repeat is comparable: scripts kept outside the repository and deleted afterwards; `APPOINTMENT_STORE=memory` for that process only (no Supabase); a network guard that allows only loopback and `api.groq.com`, only the transcription and chat endpoints, at most 1 and 4 requests, with no SDK retries and a ceiling on tokens; pacing so the per-minute token peak stays under 7,000; the browser started with a dead proxy and only loopback exempt; and an audit that reports only booleans and counters (never the transcript, the date, a token or an identifier). The STT budget (audio-seconds and requests) is counted apart from the agent's tokens. There is no committed live voice evaluation harness.

Known logging gaps (reported by the C3 and review work, not fixed): the API logger's own lines carry no identifier, but (1) uvicorn's access log prints request paths such as `GET /v1/appointments/<id>` and is enabled by the documented run commands, so it must be disabled or redacted in a deployment (Milestone 5), and (2) the unhandled-error handler logs a traceback whose exception messages are not redacted (the current code paths use fixed messages, so no identifier is known to reach it).

Text agent end-to-end check (provider-backed; done once for Milestone 3, needs explicit approval each time because it uses the real provider): start the API with `APPOINTMENT_STORE=memory` set only for that process (`python -m uv run python -m uvicorn voice_agent_api.main:app --host 127.0.0.1 --port 8000` from `apps/api`, with `AGENT_PROVIDER` and `AGENT_MODEL` set), run `pnpm build` then `pnpm start` in `apps/web`, and drive a throwaway headless Edge or Chromium profile over the DevTools protocol (no extensions, no signed-in profile; scripts and screenshots outside the repository, not committed). One fresh fictional conversation: ask for times, check no review exists, choose a time in a later message, check one review, press **Confirm booking** once, and check one appointment and an idempotent replay. Also check layout at 1440, 390 and 320 px and at 200% text, axe, keyboard order and focus, no console errors, and that the proposal token appears only in the form's hidden input and in no log. Rehearse the whole script first against a scripted model on other ports: that rehearsal for Milestone 3 found a real layout defect (the confirm button overflowing at 320 px and 200% text) before the single provider-backed run. Afterwards stop every process and confirm the in-memory appointment is gone.

`langgraph` pins `langgraph-sdk`, which requires `websockets<17`, so `websockets` resolves to 16.1.1. Nothing in the project uses WebSockets (voice is request and response, not streaming); re-evaluate this before any streaming work.

After changing an API schema: regenerate `openapi.json`, then run `pnpm gen:api`, and commit both. `apps/api/tests/api/test_openapi_contract.py` fails when `openapi.json` is stale.

The API reads `apps/api/.env` (git-ignored; see `apps/api/.env.example`, placeholders only) and the process environment. Without either it runs in memory mode with seed data, which is what the tests and the smoke test below use. `VOICE_AGENT_ENV_FILE` overrides the file path (an empty value disables it). The web app never receives any database setting or the signing key.

Smoke test (memory mode) with both servers running: `/health`, `/v1/business`, `/v1/services`, and `/v1/services/flat-repair/availability?date=<a Tuesday to Saturday within 14 days>` on port 8000; then `/` and `/?service=flat-repair&date=<same date>` on port 3000. Open times on the home page are text, not links; the one call to action goes to `/assistant?service=flat-repair&date=<same date>`, which must show an editable draft and send nothing. `/book` (any query) must answer a 307 to `/assistant`, keeping only a well-formed `service`. A booking review appears only inside the chat (it needs a model; use the offline rehearsal below), saves nothing until **Confirm booking** is pressed, and confirming must land on `/appointments/<id>`. Stop the API and reload the web pages to confirm the unavailable notice appears, including on confirm. Seeded bookings are generated relative to the clock when the API starts, so a server left running for days keeps bookings that are now in the past; restart it to refresh the demo gaps. On Windows, `fastapi dev` leaves its worker process holding the port if only the parent is killed, so stop the whole process tree.

## Database and secrets

Everything here changes a remote project or creates a secret, so each step waits for explicit approval. Run Supabase CLI commands from `apps/api`. The migrations are in `apps/api/supabase/migrations/`, created by `supabase migration new` so the CLI chose the timestamped names; do not rename or invent files by hand.

| Step | Command | Effect |
| --- | --- | --- |
| Link (local config only) | `pnpm dlx supabase@2.119.0 link --project-ref <ref>` | Prompts for the postgres password. Never pass it as a flag. |
| Read-only checks | `pnpm dlx supabase@2.119.0 migration list`, `psql --version` | None. Also check `select version()` and that `btree_gist` is available. |
| Preview, then apply | `pnpm dlx supabase@2.119.0 db push --dry-run`, then `db push` | **Remote mutation.** |
| Advisors | `pnpm dlx supabase@2.119.0 db advisors --linked --type security`, then `--linked --type performance` | Read-only. Expect no ERROR or WARN for `booking.*`. |
| Generate secrets | `python -m uv run python -m voice_agent_api.devtools.secrets generate` | Creates `apps/api/.env` locally. |
| Set the role password | In `psql` as `postgres.<ref>` on the session pooler: `\password voice_agent_api`, paste `DB_PASSWORD` from `.env` at the hidden prompt, then `alter role voice_agent_api login;` | **Remote mutation.** Never use the Supabase SQL Editor for passwords. |
| Check connectivity | `python -m uv run python -m voice_agent_api.devtools.secrets check --connect` | Prints pass or fail only. |

Fill the non-secret `DB_HOST`, `DB_USER` (`voice_agent_api.<project_ref>`) and `DB_SSLROOTCERT` (the CA certificate from the dashboard) in `.env`, then set `APPOINTMENT_STORE=postgres`.

Verifying against the real database (done once for Milestone 2; repeat after DB-facing changes):

1. `python -m uv run pytest -m integration` (15 tests; creates and deletes only `source = 'test'` rows, and leaves none behind).
2. With `APPOINTMENT_STORE=postgres`, `python -m uv run python -m voice_agent_api.demo_reset --yes` deletes only `seed` and `web_demo` rows and inserts the four fictional seed bookings. Afterwards the counts by source should be `seed = 4` and nothing else.
3. Start the API and `pnpm build && pnpm start` in `apps/web`, then repeat the smoke test above. Also check that a review writes nothing, that confirming the same review (the same proposal token) twice yields one appointment (two separate reviews are not deduplicated; see ADR 0004), that a full slot shows the conflict, and that stopping the API shows the unavailable notice and a retry works.
4. For a browser check, drive a headless Chromium-based browser over the DevTools protocol against `localhost` with a throwaway profile (no extensions, no signed-in profile), keeping screenshots outside the repository. Check at 1440, 390 and 320 px and at 200% text: no horizontal scroll, axe-core clean, keyboard order and focus, no console errors. The scripts used for Milestone 2 are not committed.
5. Run `demo_reset --yes` again, and confirm there are no `test` rows.

Server-side SSL enforcement is not enabled (it reboots the database); clients already use `sslmode=verify-full`.

Rotation or suspected leak: `secrets generate --rotate`, run `\password voice_agent_api` again with the new `DB_PASSWORD`, and restart the API. The old password stops working immediately. The role has one password, shared by local development and the Render service: once Render exists, update both together (set the new value in the Render dashboard, then run `\password`, then restart or redeploy). A rotated signing key invalidates reviews that are open (they last 10 minutes).

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
