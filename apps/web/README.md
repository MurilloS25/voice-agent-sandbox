# Web

Next.js (App Router), React, TypeScript, and Tailwind CSS front end for Voice Agent Sandbox.

Commands are listed in [docs/HARNESS.md](../../docs/HARNESS.md). Server Components fetch from the API using the server-only `API_BASE_URL` variable (see `.env.example`). Types in `src/lib/api/schema.d.ts` are generated from `apps/api/openapi.json`; do not edit them by hand.
