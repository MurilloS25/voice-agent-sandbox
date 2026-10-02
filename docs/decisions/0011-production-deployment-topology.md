# Deployment topology: Vercel web, a single always-on FastAPI service, Supabase and Groq

- Status: **proposed** (awaiting gate G0 of [plan 0007](../plans/0007-production-hardening-and-deployment.md)). Nothing described here is built or deployed. Prices and limits are as the official pages stated them on 2026-10-02; the plan lists what could not be confirmed.
- Date: 2026-10-02

## Context

The assistant (text agent, voice input and output, booking review with explicit confirmation) runs locally and is verified offline. It must be reachable from a portfolio at a public URL without becoming a way to spend someone else's model budget, to leak visitor text into logs, or to leave a recruiter waiting on a sleeping server. Constraints from earlier decisions: conversations and turn idempotency live in one process's memory ([ADR 0007](0007-agent-orchestration-and-tool-boundary.md)); the browser never calls the API (see `docs/ARCHITECTURE.md` and [ADR 0009](0009-voice-input-and-spoken-output.md)); the database role is least-privilege and reached over `verify-full` TLS ([ADR 0002](0002-direct-postgres-private-schema.md), [ADR 0006](0006-secret-provisioning-and-validation.md)); a booking exists only after an explicit confirmation of a signed proposal ([ADR 0004](0004-signed-proposals-and-stale-detection.md)).

## Decision (proposed)

1. **Web on Vercel Hobby** (Root Directory `apps/web`). A personal portfolio with no payments or ads is within Hobby's non-commercial rule; the function limits (300 s, 4.5 MB body) are far above this app's needs.
2. **API as one FastAPI process on Render**, started on the Free plan for verification and moved to an always-on plan before the link is shared, with exactly one instance (the in-memory store requires it). The code is identical on both plans.
3. **Supabase Postgres through the shared pooler in session mode (port 5432)**, `sslmode=verify-full` with the public CA certificate, the existing `voice_agent_api` role with a new production password. Transaction mode (6543) is reserved for a serverless API.
4. **Groq** through a dedicated production project and key with per-model custom limits and Zero Data Retention confirmed for its organization.
5. **The API is not a public service.** Every route except `GET /health` requires a server-to-server bearer secret; the web tier forwards only a keyed hash of the client address; the API ignores forwarded-address headers and sends no CORS headers; its interactive docs are off in production.
6. **Budgets are layered**: per-client and global rate limits and daily token and audio-second budgets in the API (in memory, conservative defaults derived from the provider's published limits and measured usage), with the provider's project limits as the hard backstop.
7. **A cold or restarted API is made visible, not hidden**: a readiness gate with an explicit "Starting workshop assistant…" state, bounded polling and no keep-alive pinging.
8. **Logs carry no visitor text, transcript, audio, token, identifier or provider payload**, enforced by sentinel tests; access logging is off.

## Consequences

- **Cost** is zero while on the free tiers and one fixed monthly amount for an always-on Render instance (the owner must read it on the official pricing page: it could not be read from the page during this research). No configuration in this decision can produce an open-ended bill: Vercel Hobby pauses instead of billing, Supabase Free and Render Free cannot bill, and Groq bills only if a paid tier is chosen, in which case an organization spend limit is required.
- **Availability** on the free tiers is the cost: Render Free sleeps after 15 minutes and takes about a minute to wake, and Supabase Free may pause an inactive project (the rule was not stated in the page read). The readiness probe reports both; there is no artificial keep-alive.
- **State**: conversations are lost on a restart or deploy. The UI already ends such a conversation with a notice and keeps the visitor's text; the plan adds one explicit action to start again with the last message restored. Nothing about visitors is persisted.
- **Single instance** means no horizontal scaling and brief unavailability during deploys beyond Render's zero-downtime window for a service that cannot run two copies of itself; acceptable for a portfolio.
- The in-memory counters reset on restart, which is why the provider-side limits are part of the design.
- No database migration is needed. A rollback is a Render deploy rollback and a Vercel promotion of the previous deployment; secrets are rotated by replacing dashboard values.

## Alternatives considered

- **Render Free only (no upgrade).** Zero cost, but a first visit after idle can take about a minute; acceptable as the verification environment, poor as the public default. It stays available as a fallback because the code does not change.
- **Vercel Python API (serverless) with a persistent store.** The most stateless shape and no cold start worth the name, but it needs Postgres-backed conversations, idempotency, rate limits and budgets (a migration and new ADRs), stores visitor text (retention policy), has a 500 ms shutdown window for cleanup, forces transaction pooling with many instances, and its cold start with this dependency set was never measured. Deferred as a possible later phase.
- **Keep the API public with only provider-side limits.** Rejected: anyone with the URL could spend the budget and the provider's ceiling would be the only brake.
- **Trust `X-Forwarded-For` at the API.** Rejected: behind Render the API cannot tell a real forwarded address from a forged one; Vercel overwrites the header and the web tier is the only place the real address is known and trusted.
- **A scheduled pinger to keep Render Free awake.** Rejected: it works against the plan's documented behaviour; the remedy for a cold start is an always-on plan.
- **Supabase direct connection (IPv6) or transaction mode for a long-lived server.** Rejected: the shared pooler's session mode works over IPv4 on every plan and keeps session features; transaction mode is for many short-lived clients.
