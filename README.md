# Voice Agent Sandbox

Portfolio project exploring how a voice-enabled AI agent can handle realistic business workflows in a safe demo environment.

## Status

Development harness ready; implementation has not started.

## Start here

- [Architecture](docs/ARCHITECTURE.md)
- [Development harness](docs/HARNESS.md)
- [Agent guide](AGENTS.md)

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


