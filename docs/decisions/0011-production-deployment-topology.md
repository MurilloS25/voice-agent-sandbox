# Deployment topology: Vercel web, a single FastAPI service on Render Free, Supabase and Groq

- Status: **accepted** (owner approved G0 with decisions D1 to D9 on 2026-10-02). The topology is deployed and running from `main` (2026-10-03): Vercel Hobby (public production, protected previews), Render Free, Supabase Free and Groq Free. Prices and limits are as the official pages stated them on 2026-10-02.
- Date: 2026-10-02

## Context

The assistant (text agent, voice input and output, booking review with explicit confirmation) runs locally and is verified offline. It must be reachable from a portfolio at a public URL without becoming a way to spend someone else's model budget, to leak visitor text into logs, or to leave a recruiter waiting on a sleeping server. Constraints from earlier decisions: conversations and turn idempotency live in one process's memory ([ADR 0007](0007-agent-orchestration-and-tool-boundary.md)); the browser never calls the API (see `docs/ARCHITECTURE.md` and [ADR 0009](0009-voice-input-and-spoken-output.md)); the database role is least-privilege and reached over `verify-full` TLS ([ADR 0002](0002-direct-postgres-private-schema.md), [ADR 0006](0006-secret-provisioning-and-validation.md)); a booking exists only after an explicit confirmation of a signed proposal ([ADR 0004](0004-signed-proposals-and-stale-detection.md)).

## Decision

1. **Web on Vercel Hobby** (Root Directory `apps/web`). A personal portfolio with no payments or ads is within Hobby's non-commercial rule; the function limits (300 s, 4.5 MB body) are far above this app's needs.
2. **API as one FastAPI process on Render Free**, with exactly one instance (the in-memory store requires it). Vercel Hobby + Render Free + Supabase Free + Groq Free is the approved topology for the initial publication; no paid Render plan is required before sharing the link and no monthly cost is a requirement. Render may sleep the service after 15 minutes without traffic and take about a minute to wake: the approved mitigation is the "Starting workshop assistant…" experience (item 7). If Render allows creating the service without a payment method, that is the recommended route, so no charge can happen by accident; if a free limit is reached we prefer a controlled suspension or unavailability to a charge. An always-on plan is only an optional future improvement: the same image and code work on it, but nothing here assumes it.
3. **Supabase Postgres through the shared pooler in session mode (port 5432)**, `sslmode=verify-full` with the public CA certificate, the existing `voice_agent_api` role of the existing project (decision of 2026-10-03: no second project and no second role). A role has one password, so development and production share it: a rotation must update the local `apps/api/.env` and the Render `DB_PASSWORD` together (the old password stops working at once). Transaction mode (6543) is reserved for a serverless API.
4. **Groq** through a dedicated production project and key with per-model custom limits and Zero Data Retention confirmed for its organization.
5. **The API is not a public service.** Every route except `/health/live` and `/health/ready` requires a server-to-server bearer secret; the web tier forwards only a keyed hash of the client address; the API ignores forwarded-address headers and sends no CORS headers; its interactive docs are off in production.
6. **Budgets are layered**: per-client and global rate limits and daily token and audio-second budgets in the API (in memory, conservative defaults derived from the provider's published limits and measured usage), with the provider's project limits as the hard backstop.
7. **A cold or restarted API is made visible, not hidden**: a readiness gate with an explicit "Starting workshop assistant…" state, polling that only a real visit triggers, bounded, and no keep-alive pinging.
8. **Logs carry no visitor text, transcript, audio, token, identifier or provider payload**, enforced by sentinel tests; access logging is off.

## Consequences

- **Cost** is zero: Render Free, Supabase Free and Vercel Hobby cannot bill (they suspend or pause) and Groq stays on its Free tier. No configuration in this decision can produce a charge.
- **Availability** on the free tiers is the cost: Render Free sleeps after 15 minutes and takes about a minute to wake, and Supabase Free may pause an inactive project (the rule was not stated in the page read). The readiness probe reports both; there is no artificial keep-alive. Render Free's behaviour is accepted rather than worked around.
- **State**: conversations are lost on a restart or deploy. The UI already ends such a conversation with a notice and keeps the visitor's text; the plan adds one explicit action to start again with the last message restored. Nothing about visitors is persisted.
- **Single instance** means no horizontal scaling and brief unavailability during deploys beyond Render's zero-downtime window for a service that cannot run two copies of itself; acceptable for a portfolio.
- The in-memory counters reset on restart, which is why the provider-side limits are part of the design.
- No database migration is needed. A rollback is a Render deploy rollback and a Vercel promotion of the previous deployment; secrets are rotated by replacing dashboard values.

## Alternatives considered

- **An always-on Render plan.** Instant and consistent, but it adds a fixed monthly cost the portfolio does not need. Kept as an optional future improvement; the code does not change.
- **Vercel Python API (serverless) with a persistent store.** The most stateless shape and no cold start worth the name, but it needs Postgres-backed conversations, idempotency, rate limits and budgets (a migration and new ADRs), stores visitor text (retention policy), has a 500 ms shutdown window for cleanup, forces transaction pooling with many instances, and its cold start with this dependency set was never measured. Deferred as a possible later phase.
- **Keep the API public with only provider-side limits.** Rejected: anyone with the URL could spend the budget and the provider's ceiling would be the only brake.
- **Trust `X-Forwarded-For` at the API.** Rejected: behind Render the API cannot tell a real forwarded address from a forged one; Vercel overwrites the header and the web tier is the only place the real address is known and trusted.
- **A scheduled pinger to keep Render Free awake.** Rejected: it works against the plan's documented behaviour; the cold start is accepted and made visible instead.
- **Supabase direct connection (IPv6) or transaction mode for a long-lived server.** Rejected: the shared pooler's session mode works over IPv4 on every plan and keeps session features; transaction mode is for many short-lived clients.
