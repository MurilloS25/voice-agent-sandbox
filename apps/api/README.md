# API

FastAPI backend for Voice Agent Sandbox. It serves fictional business data and deterministic availability, and creates appointments only from a reviewed, explicitly confirmed, signed proposal. Storage is in memory by default or PostgreSQL (Supabase) when `APPOINTMENT_STORE=postgres`.

Commands are listed in [docs/HARNESS.md](../../docs/HARNESS.md). Layout:

- `src/voice_agent_api/domain`: framework-free models, availability and bench rules, propose and confirm commands, the catalog fingerprint, and ports.
- `src/voice_agent_api/infrastructure`: the in-memory adapter (with the fictional seed data) and the PostgreSQL adapter.
- `src/voice_agent_api/api`: routes (plain `def`, so they run in the worker threadpool), response schemas, the proposal token codec, dependencies, and the error envelope.
- `src/voice_agent_api/factory.py`: builds the app from explicit parts. `main.py` is the entrypoint that loads settings and `.env`.
- `src/voice_agent_api/config.py`, `devtools/secrets.py`, `demo_reset.py`: validated settings, local secret generation and checking, and the demo reset.
- `supabase/migrations`: the schema, catalog seed and API role, created with the Supabase CLI.
- `openapi.json`: generated contract, checked by a test.
- `tests/integration`: database tests, excluded unless run with `-m integration`.

Copy `.env.example` to `.env` only if you need non-default settings; it holds placeholders only.
