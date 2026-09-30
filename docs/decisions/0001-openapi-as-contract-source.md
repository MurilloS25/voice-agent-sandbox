# FastAPI's OpenAPI schema is the API contract

- Status: accepted
- Date: 2026-09-30

## Context

The web app and the API are separate deployables written in different languages, and the agent and appointment features will add more endpoints and error shapes. A hand-maintained copy of the response types on the web side would drift without anyone noticing. The repository layout reserves `packages/contracts` for provider-neutral schemas, but AGENTS.md says to add a boundary only when the implemented slice needs it.

## Decision

- The Pydantic models in `apps/api/src/voice_agent_api/api/schemas.py` are the single source of truth for the wire format.
- `apps/api/openapi.json` is generated from the app and committed. A pytest test fails when the file is stale.
- `apps/web/src/lib/api/schema.d.ts` is generated from `openapi.json` with `openapi-typescript` (`pnpm gen:api`) and committed.
- `packages/contracts` is not created.

## Consequences

- A schema change requires two generation steps, and the drift test tells the developer which one is missing.
- The web client gets compile-time types for responses and error envelopes without a shared package or a JavaScript workspace.
- The generated types describe the wire format only. The client does not validate responses at runtime, so a server bug that violates its own schema is not caught in the browser.
- If a second consumer appears, or contracts must exist without a running FastAPI app (for example evaluation scenarios), revisit this and extract `packages/contracts`.

## Alternatives considered

- **Hand-written TypeScript types:** simplest, but drift is silent.
- **`packages/contracts` with JSON Schema or Zod as the source:** duplicates what FastAPI already produces and needs a code-generation step in both directions.
- **Runtime validation of responses in the web client (for example Zod):** stronger guarantees, but more code than this slice needs. It can be added later behind `src/lib/api/client.ts` without changing callers.
