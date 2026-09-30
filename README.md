# Voice Agent Sandbox

Portfolio project exploring how a voice-enabled AI agent can handle realistic business workflows in a safe demo environment.

## Status

Foundation milestone implemented ([plan](docs/plans/0001-project-foundation.md)): a FastAPI backend with deterministic availability for a fictional bicycle workshop, and a Next.js page that shows its services, opening hours, and open appointment times. The page is read-only. The agent, voice, persistence, and appointment changes are not built yet.

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

The business, services, and seeded bookings are fictional and held in memory. The web app reads the API address from `API_BASE_URL` (default `http://127.0.0.1:8000`).

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


