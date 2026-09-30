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
- The domain layer (`apps/api/src/voice_agent_api/domain`) has no framework imports and reaches storage only through the `BusinessCatalog` and `AppointmentBook` ports. An in-memory adapter implements them today.
- Deploy the web interface to Vercel; choose API hosting only after validating streaming and latency requirements.

## First vertical slice

A user asks about services and availability, selects a fictional slot, confirms it, and receives a persisted appointment plus a visible tool-event timeline. Text interaction is sufficient for this slice. Voice, rescheduling, cancellation, and richer evaluation follow after the core behavior is measured.

## Decisions still requiring evidence

- Browser speech APIs versus a realtime speech/model provider.
- Streaming protocol between browser and API.
- API hosting compatible with the selected streaming approach.
- Authentication depth required for a public portfolio demo.
- Exact data retention window for transcripts and execution events.
