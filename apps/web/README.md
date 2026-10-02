# Web

Next.js (App Router), React, TypeScript, and Tailwind CSS front end for Voice Agent Sandbox.

Commands are listed in [docs/HARNESS.md](../../docs/HARNESS.md). Server Components and the `confirmBooking` Server Action call the API through `src/lib/api/client.ts`, which imports `server-only` and uses the server-only `API_BASE_URL` variable (see `.env.example`). The browser never calls the API and never sees a database setting or signing key. Types in `src/lib/api/schema.d.ts` are generated from `apps/api/openapi.json`; do not edit them by hand.

## Assistant (`/assistant`)

A plain-text chat with the workshop's agent (plan 0003, phase 3C). The chat state lives in component memory only: nothing is written to `localStorage`, `sessionStorage`, cookies or a database, and a reload starts fresh.

- `src/app/assistant/actions.ts` (`sendTurn`) calls `sendAgentTurn` in `src/lib/api/client.ts` (26 s budget, `AGENT_TURN_TIMEOUT_MS`) and reduces every API status to a small outcome: answered, retry (unknown outcome, in progress, busy), assistant not available, conversation ended, or message refused.
- `src/components/ChatPanel.tsx` makes the conversation id (`crypto.randomUUID()`) on the first send, a new turn id per new message and a 1-based turn index, and keeps the exact pending submission until a terminal answer arrives. A retry resends the identical four values; the turn index advances only when a turn is accepted. If the API has lost the conversation (it restarted or it expired) the transcript stays on the page read-only and "Start a new conversation" keeps it as an earlier conversation.
- `Transcript` renders every message as plain text (no Markdown, HTML or generated links). A booking review reuses `BookingReview` and the existing `ConfirmForm` unchanged, so the proposal token exists only in that form's hidden field, and only the newest review can be confirmed. `ExecutionTimeline` lists typed events only.
- With no model provider configured (the default) the page shows "The assistant isn't switched on" and a link to the booking form.
