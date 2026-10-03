# Voice Agent Sandbox

Portfolio project exploring how a voice-enabled AI agent can handle realistic business workflows in a safe demo environment.

## Live demo

**https://voice-agent-sandbox.vercel.app/**

A public, fictional bicycle workshop you can talk to. It runs on free tiers: the web app on Vercel Hobby, the API on Render Free, the data on Supabase Free and the model and speech on Groq Free. Because Render Free puts the API to sleep after about 15 minutes without traffic, the **first visit can take about a minute** ("Starting workshop assistant…") while it wakes up. Free tiers have daily limits, and the demo has its own daily budget and rate limits, so it may pause or be unavailable; there is no availability guarantee, no service level and no promise that it stays free or online. Only fictional data is used and no audio is kept.

## Status

Four milestones are implemented:

- Foundation ([plan](docs/plans/0001-project-foundation.md)): a FastAPI backend with deterministic availability for a fictional bicycle workshop, and a Next.js page that shows its services, opening hours, and open appointment times.
- Booking with explicit confirmation ([plan](docs/plans/0002-booking-persistence.md)): pick an open time, review exactly what will be booked, and confirm it explicitly. Confirmation re-checks availability transactionally, assigns one of two benches, is idempotent, and detects a changed catalog or a taken slot without writing. It runs in memory by default and against a Supabase PostgreSQL development project when configured: the migrations are applied, the integration tests pass against the real database, and the full flow was verified through the production web build and a scripted headless browser. Server-side SSL enforcement is not enabled yet (clients already verify the certificate), and a hand review on a real phone and screen reader is still open (see the plan).

- Text agent ([plan 0003](docs/plans/0003-text-agent-orchestration.md), [ADR 0007](docs/decisions/0007-agent-orchestration-and-tool-boundary.md), [ADR 0008](docs/decisions/0008-model-provider-adapter-and-selection.md)): a text-first booking assistant at `/assistant` for the fictional shop. A hand-written LangGraph turn graph runs four typed, allow-listed tools that read business facts and availability and prepare a booking review; the agent cannot book. A time can be reviewed only if it was offered in an earlier turn, and booking still happens only when the visitor presses the existing **Confirm booking** button. Conversations are held in memory with idempotent turns (within one API process), every model and tool call is time-bounded, and a structured execution timeline shows what the visitor said, what the assistant asked tools to do and what they returned. A Groq adapter sits behind a provider-neutral factory and is **disabled by default**; without a provider the page shows a notice with a link to the booking form. The model selected after paced live evaluations is `openai/gpt-oss-120b`, set through `AGENT_MODEL` (nothing is hard-coded): it passed 12 of 12 scenarios in the final run, after earlier runs of the same model had failed some (one sample of a nondeterministic model). A real-provider browser check ran one two-turn conversation through the existing confirmation, with one appointment created and a replay creating no duplicate.

Limits of this milestone: conversations live in one process's memory and are lost on restart; turn idempotency does not survive a restart; at the time of this milestone there was no rate limit or spend cap (both were added later, see plan 0007); the Groq setup assumes the operator enabled Zero Data Retention on their own account (the repository cannot verify it); streaming, persisted conversations, authentication, rescheduling, cancellation and deployment are not built (voice is described in the next bullet). This is a portfolio demo with fictional data, not a production-ready system.

- Voice ([plan 0004](docs/plans/0004-voice-experience.md), [ADR 0009](docs/decisions/0009-voice-input-and-spoken-output.md)): voice as an input and output layer around the same text agent, verified offline and at two live checkpoints. On `/assistant` the visitor presses **Speak**, says one short sentence and presses **Stop**; the recording goes through a same-origin route handler to `POST /v1/speech/transcriptions`, and the transcript appears in the message box, editable and never sent automatically. The agent, its tools and the booking confirmation are unchanged: voice adds no capability and no write path. Replies can be read aloud by the browser's own synthesized voice (Listen/Stop per reply, and a "Read replies aloud" switch that is off by default); a network-only voice needs an explicit opt-in because the browser or operating system may send the reply text to an external service. Speech-to-text sits behind a provider-neutral port with an offline scripted fake (accepted only when `APP_ENV` is explicitly `development` or `test`) and an optional Groq adapter, both **disabled by default** (`SPEECH_PROVIDER=disabled`). No audio is stored anywhere: it exists in browser memory until upload and in API memory for one request. Everything above was verified offline and in scripted headless-browser rehearsals. At two live checkpoints (2026-10-01) the real Groq services were exercised with synthetic audio only: C2, one transcription (1 request, HTTP 200, 10 billed audio-seconds), and C3, one end-to-end session in a headless browser with a fake microphone device (1 transcription request, 4 chat requests, 10 billed audio-seconds, 6,264 agent tokens, one appointment in memory and a replay without a duplicate); details are in the plan's closeout. A real microphone, real speech synthesis voices, a phone, a screen reader and browsers other than Edge were **not** exercised.

Limits of the voice milestone: the server enforces the byte limit (256 KB), the container family, concurrency and time, and does **not** measure how long the audio is (the 15 s and 0.3 s limits are enforced in the browser only); per-visitor and global rate limits and a daily PostgreSQL-backed budget now bound transcription (verified locally; not yet deployed); the Groq adapter was exercised against the real service only at the two checkpoints above and assumes the operator enabled Zero Data Retention on their own account (confirmed by the operator, not verifiable from the repository); the API's logs avoid identifiers, but uvicorn's own access log prints request paths, including `GET /v1/appointments/<id>`, so the production image disables it; voice is English only.

- Voice-first experience ([plan 0006](docs/plans/0006-voice-first-experience.md), [ADR 0010](docs/decisions/0010-voice-first-assistant-experience.md)): `/assistant` is now a full-height voice app with a text alternative. The visitor presses **Start voice assistant** (a local line plays from that click: the full introduction for a new conversation, only "Voice mode is ready." for one that already has messages; nothing is recorded or sent), taps to speak, and what is heard is sent as the next turn (or, with **Review transcript before sending** on, shown for editing first); replies are read aloud by the browser's own voice while the session is on, with **Stop speaking** and **End voice session**. The central orb is an animated SVG that follows the real microphone volume while listening (analysed in the browser only). A network voice the visitor picks and agrees to is remembered for that voice in the browser. Voice and Text are two views of one conversation, the booking review and its unchanged **Confirm booking** button stay where the visitor can see them, and the transcript, the execution timeline and **Voice settings** (voice, speed, preview) are secondary panels. It is still turn-based, not a streaming conversation, and it uses only voices already on the device. Verified offline in unit tests and in scripted headless Edge rehearsals (a stub `speechSynthesis`, a fake microphone, no provider call); a real microphone, real voices, a phone and a screen reader were **not** exercised.

The production hardening and the free-tier deployment are described in [plan 0007](docs/plans/0007-production-hardening-and-deployment.md) and [ADR 0011](docs/decisions/0011-production-deployment-topology.md). Streaming, authentication, rescheduling, cancellation, persisted conversations and telephony are not built.

Known limits of the deployment: a cold start of about a minute on Render Free; conversations live in one process's memory and are lost on a restart; a withdrawn booking review is remembered per process; the Content-Security-Policy is still Report-Only; and the free tiers' own limits apply.

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
- Browser capture (`MediaRecorder`) and the browser's `speechSynthesis`, with speech-to-text behind a provider-neutral port (optional Groq adapter)
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


