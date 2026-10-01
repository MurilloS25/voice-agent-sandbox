# Web

Next.js (App Router), React, TypeScript, and Tailwind CSS front end for Voice Agent Sandbox.

Commands are listed in [docs/HARNESS.md](../../docs/HARNESS.md). Server Components and the `confirmBooking` Server Action call the API through `src/lib/api/client.ts`, which imports `server-only` and uses the server-only `API_BASE_URL` variable (see `.env.example`). The browser never calls the API and never sees a database setting or signing key. Types in `src/lib/api/schema.d.ts` are generated from `apps/api/openapi.json`; do not edit them by hand.
