# Architecture

## Product boundary

Voice Agent Sandbox is a safe, inspectable demonstration of a voice-enabled appointment workflow for a fictional service business. It is not a production telephony system and must not ingest real customer data.

## Proposed components

1. **Web application** — Next.js UI for text and browser voice interaction, transcript presentation, confirmations, and the execution timeline.
2. **API application** — FastAPI boundary for sessions, agent turns, business queries, and appointment commands.
3. **Agent orchestration** — LangGraph state machine that selects constrained domain tools and produces responses grounded in tool results.
4. **Domain layer** — deterministic availability, appointment, and business-rule services independent from the model provider.
5. **Persistence** — Supabase PostgreSQL for fictional business configuration, appointments, session metadata, and tool events. Raw audio is excluded.
6. **Evaluation layer** — version-controlled scenarios covering intent recognition, tool selection, confirmations, refusals, recovery, latency, and cost.

## Principal flows

The browser sends transcript text to the API. The orchestration layer interprets the turn and may query deterministic read tools. A proposed mutation is returned to the UI for explicit confirmation. Only a confirmed command reaches the domain service and database. The API emits structured events so the UI can show what happened without exposing hidden reasoning.

## Trust boundaries

- Browser input is untrusted.
- Model output is untrusted until schema validation succeeds.
- Tool inputs are authorized and validated by application code.
- Database policies are defense in depth, not a replacement for server authorization.
- Provider responses and failures are external, variable inputs.

## Provisional choices

- Start text-first and introduce voice after the complete appointment slice works.
- Start with browser speech capabilities, but isolate them behind an adapter because browser support and quality vary.
- Use PostgreSQL because appointments, availability, and audit events are relational.
- Store structured execution events, not chain-of-thought or raw audio.
- The web app calls the API from Server Components, so the browser never contacts the API directly and no CORS is configured yet. Response types are generated from FastAPI's OpenAPI schema ([ADR 0001](decisions/0001-openapi-as-contract-source.md)).
- The domain layer (`apps/api/src/voice_agent_api/domain`) has no framework imports and reaches storage only through the `BusinessCatalog` and `AppointmentBook` ports. An in-memory adapter (the default, used by unit tests) and a PostgreSQL adapter implement them.
- The API talks to PostgreSQL directly with psycopg, in a private `booking` schema, as a least-privilege role, with no Data API and no Supabase key ([ADR 0002](decisions/0002-direct-postgres-private-schema.md)). Blocking database calls always run in the worker threadpool and every request has bounded timeouts.
- Each appointment holds one bench and the database enforces it with an exclusion constraint ([ADR 0003](decisions/0003-one-bench-per-appointment.md)).
- A booking is created only from a signed, short-lived proposal that is re-derived and fingerprint-checked on confirm, and is idempotent per proposal ([ADR 0004](decisions/0004-signed-proposals-and-stale-detection.md)).
- The catalog lives in PostgreSQL and changes only through Supabase CLI migrations ([ADR 0005](decisions/0005-catalog-in-postgres-via-cli-migrations.md)). Secrets are generated locally and validated at startup ([ADR 0006](decisions/0006-secret-provisioning-and-validation.md)).
- The text agent (phase 3A of [plan 0003](plans/0003-text-agent-orchestration.md), [ADR 0007](decisions/0007-agent-orchestration-and-tool-boundary.md)) is a hand-written LangGraph turn graph over four allow-listed, validated tools. It receives a read-only appointment book and cannot reach confirmation: the proposal token goes only to the browser through the typed `booking_review` field, and booking still happens only through the existing signed-proposal confirm. Conversations and events are held in memory, with idempotent turns that hold within one API process; accepted turns answer 200 (completed or degraded), and every model, tool and catalog call has a bounded wait under a 21 s turn bound. `POST /v1/agent/turns` returns 503 until a provider is configured. A Groq adapter sits behind a provider-neutral factory (phase 3B, [ADR 0008](decisions/0008-model-provider-adapter-and-selection.md), draft): disabled by default, no automatic retries, no model id in code, and verified offline only; no live provider call has been made and no model is selected. The web chat (`/assistant`, phase 3C) renders the transcript and the typed execution timeline as plain text, holds its state in browser memory only, and reuses the existing review and confirm form; with the provider disabled it falls back to a link to the booking form.
- Deploy the web interface to Vercel; choose API hosting only after validating streaming and latency requirements.

## First vertical slice

A user asks about services and availability, selects a fictional slot, confirms it, and receives a persisted appointment plus a visible tool-event timeline. Text interaction is sufficient for this slice. The select, review, confirm and persist part is built ([plan 0002](plans/0002-booking-persistence.md)); the agent orchestration and its structured timeline exist behind `POST /v1/agent/turns` and are tested offline with a scripted model ([plan 0003](plans/0003-text-agent-orchestration.md), phase 3A); the model provider is not configured, and the conversational web interface (`/assistant`) is built but has only been exercised against the disabled-provider fallback. Voice, rescheduling, cancellation, and richer evaluation follow after the core behavior is measured.

## Decisions still requiring evidence

- Browser speech APIs versus a realtime speech/model provider.
- Streaming protocol between browser and API.
- API hosting compatible with the selected streaming approach.
- Authentication depth required for a public portfolio demo.
- Exact data retention window for transcripts and execution events.
