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
- The text agent (phase 3A of [plan 0003](plans/0003-text-agent-orchestration.md), [ADR 0007](decisions/0007-agent-orchestration-and-tool-boundary.md)) is a hand-written LangGraph turn graph over four allow-listed, validated tools. It receives a read-only appointment book and cannot reach confirmation: the proposal token goes only to the browser through the typed `booking_review` field, and booking still happens only through the existing signed-proposal confirm. Conversations and events are held in memory, with idempotent turns that hold within one API process; accepted turns answer 200 (completed or degraded), and every model, tool and catalog call has a bounded wait under a 21 s turn bound. `POST /v1/agent/turns` returns 503 until a provider is configured. A Groq adapter sits behind a provider-neutral factory (phase 3B, [ADR 0008](decisions/0008-model-provider-adapter-and-selection.md), accepted): disabled by default, no automatic retries and no model id in code, verified offline and in paced live evaluations; `openai/gpt-oss-120b` is the selected model, set through `AGENT_MODEL` (12 of 12 scenarios in the final live run, one sample). Known limits: conversations and idempotency state are in one process's memory (lost on restart, so a retried first turn after a restart may call the model again, though it still cannot book), there is no rate limit or provider spend cap (required before any public deployment), and the Groq setup assumes Zero Data Retention was enabled by the operator. The web chat (`/assistant`, phase 3C) renders the transcript and the typed execution timeline as plain text, holds its state in browser memory only, and reuses the existing review and confirm form; with the provider disabled it falls back to a link to the booking form.
- Voice (plan 0004, [ADR 0009](decisions/0009-voice-input-and-spoken-output.md)) is an input and output layer in front of the unchanged text agent. The browser records one short clip (`getUserMedia` and `MediaRecorder`; a Speak/Stop toggle, 15 s and 0.3 s enforced in the browser only) and sends it to the same-origin route handler `POST /api/voice/transcribe` (a Server Action was rejected: an installed-Next.js check showed a started one cannot be cancelled and would block `sendTurn` and the confirmation behind it). The handler checks `Origin`, type and size, and forwards `request.signal` to `POST /v1/speech/transcriptions`, the one `async def` route in the API: it reads `request.stream()` incrementally and never keeps more than 512 KB, and hands the blocking provider call to a dedicated bounded pool (slot limit 2, deadline, abandoned calls keep their slot until they end, late results dropped unread). A `SpeechToText` port has an offline scripted fake (refused unless `APP_ENV` is `development` or `test`) and an optional Groq adapter; `SPEECH_PROVIDER` is `disabled` by default and the route then answers 503. The transcript lands in the message box and only the visitor's Send sends it; confirmation of a booking stays the existing button. Replies are optionally read by the browser's `speechSynthesis` (Listen/Stop, and an opt-in switch that is off by default); a local voice is preferred, a network voice needs an explicit opt-in, and only visible reply text is spoken. Audio is never stored. The server does **not** verify audio duration (residual risk until Milestone 5), there is no public rate limit yet, and no real provider, microphone or voice has been exercised.
- Deploy the web interface to Vercel; choose API hosting only after validating streaming and latency requirements.

## First vertical slice

A user asks about services and availability, selects a fictional slot, confirms it, and receives a persisted appointment plus a visible tool-event timeline. Text interaction is sufficient for this slice. The select, review, confirm and persist part is built ([plan 0002](plans/0002-booking-persistence.md)); the text agent and its structured timeline run behind `POST /v1/agent/turns` and the `/assistant` page ([plan 0003](plans/0003-text-agent-orchestration.md), complete): tested offline with a scripted model, evaluated live on `openai/gpt-oss-120b`, and checked once end to end in a browser against the real provider through the existing confirmation (a portfolio demo, not production-ready). Rescheduling, cancellation, and richer evaluation follow after the core behavior is measured. Voice input and spoken replies were added afterwards as a layer around the unchanged agent (plan 0004, offline-verified).

## Decisions still requiring evidence

- A realtime speech/model provider and streaming (the hybrid, request-and-response design of ADR 0009 was chosen for the portfolio demo; realtime was not evaluated beyond research).
- Streaming protocol between browser and API.
- API hosting compatible with the selected streaming approach.
- Authentication depth required for a public portfolio demo.
- Exact data retention window for transcripts and execution events.
