# Voice Agent Sandbox

Portfolio project exploring how a voice-enabled AI agent can handle realistic business workflows in a safe demo environment.

## Status

Three milestones are implemented:

- Foundation ([plan](docs/plans/0001-project-foundation.md)): a FastAPI backend with deterministic availability for a fictional bicycle workshop, and a Next.js page that shows its services, opening hours, and open appointment times.
- Booking with explicit confirmation ([plan](docs/plans/0002-booking-persistence.md)): pick an open time, review exactly what will be booked, and confirm it explicitly. Confirmation re-checks availability transactionally, assigns one of two benches, is idempotent, and detects a changed catalog or a taken slot without writing. It runs in memory by default and against a Supabase PostgreSQL development project when configured: the migrations are applied, the integration tests pass against the real database, and the full flow was verified through the production web build and a scripted headless browser. Server-side SSL enforcement is not enabled yet (clients already verify the certificate), and a hand review on a real phone and screen reader is still open (see the plan).

- Text agent ([plan 0003](docs/plans/0003-text-agent-orchestration.md), [ADR 0007](docs/decisions/0007-agent-orchestration-and-tool-boundary.md), [ADR 0008](docs/decisions/0008-model-provider-adapter-and-selection.md)): a text-first booking assistant at `/assistant` for the fictional shop. A hand-written LangGraph turn graph runs four typed, allow-listed tools that read business facts and availability and prepare a booking review; the agent cannot book. A time can be reviewed only if it was offered in an earlier turn, and booking still happens only when the visitor presses the existing **Confirm booking** button. Conversations are held in memory with idempotent turns (within one API process), every model and tool call is time-bounded, and a structured execution timeline shows what the visitor said, what the assistant asked tools to do and what they returned. A Groq adapter sits behind a provider-neutral factory and is **disabled by default**; without a provider the page shows a notice with a link to the booking form. The model selected after paced live evaluations is `openai/gpt-oss-120b`, set through `AGENT_MODEL` (nothing is hard-coded): it passed 12 of 12 scenarios in the final run, after earlier runs of the same model had failed some (one sample of a nondeterministic model). A real-provider browser check ran one two-turn conversation through the existing confirmation, with one appointment created and a replay creating no duplicate.

Limits of this milestone: conversations live in one process's memory and are lost on restart; turn idempotency does not survive a restart; there is no rate limit or spend cap, which is required before any public deployment; the Groq setup assumes the operator enabled Zero Data Retention on their own account (the repository cannot verify it); voice, streaming, persisted conversations, authentication, rescheduling, cancellation and deployment are not built. This is a portfolio demo with fictional data, not a production-ready system.
Voice, streaming, authentication, rescheduling, cancellation, persisted conversations and deployment are not built yet.

## Start here

- [Architecture](docs/ARCHITECTURE.md)
- [Development harness](docs/HARNESS.md)
- [Agent guide](AGENTS.md)

## Local development

Needs Node.js, pnpm, and Python 3.13 with uv (run as `python -m uv`). Full command list in [docs/HARNESS.md](docs/HARNESS.md).

```text
# Terminal 1: API on http://127.0.0.1:8000
cd apps/api
python -m uv sync
python -m uv run fastapi dev src/voice_agent_api/main.py

# Terminal 2: web on http://localhost:3000
cd apps/web
pnpm install
pnpm dev
```

The business, services, and seeded bookings are fictional. By default (`APPOINTMENT_STORE=memory`) they and any bookings you make are held in memory and reset when the API restarts. The web app reads the API address from `API_BASE_URL` (default `http://127.0.0.1:8000`). Database setup and secrets are covered in [docs/HARNESS.md](docs/HARNESS.md).

## Proposed MVP

- Browser-based voice input and spoken responses.
- A fictional business with seeded services, schedules, and operating rules.
- An agent that can answer questions and call tools to create, reschedule, and cancel demo appointments.
- Persistent appointments plus an auditable record of agent and tool activity.
- A clear transcript and execution timeline so decisions can be inspected.

## Proposed stack

- Next.js, React, TypeScript, and Tailwind CSS
- Python and FastAPI
- LangGraph / LangChain
- Supabase PostgreSQL
- Browser speech APIs for the initial prototype
- Vercel for the web experience

## Data approach

PostgreSQL will support business configuration, appointments, session metadata, and tool-execution logs. The demo will use fictional data and will not retain raw audio.

## What this project is meant to demonstrate

Agent orchestration, tool calling, voice interfaces, backend APIs, relational data modeling, observability, and responsible AI design.

## Initial roadmap

1. Validate browser and hosting constraints.
2. Define the demo business and conversation flows.
3. Design the agent state, tools, and database schema.
4. Build a text-first vertical slice.
5. Add voice interaction, evaluation, and deployment.


