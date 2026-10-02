# API

FastAPI backend for Voice Agent Sandbox. It serves fictional business data and deterministic availability, and creates appointments only from a reviewed, explicitly confirmed, signed proposal. Storage is in memory by default or PostgreSQL (Supabase) when `APPOINTMENT_STORE=postgres`.

Commands are listed in [docs/HARNESS.md](../../docs/HARNESS.md). Layout:

- `src/voice_agent_api/domain`: framework-free models, availability and bench rules, propose and confirm commands, the catalog fingerprint, and ports.
- `src/voice_agent_api/infrastructure`: the in-memory adapter (with the fictional seed data) and the PostgreSQL adapter.
- `src/voice_agent_api/api`: routes (plain `def`, so they run in the worker threadpool), response schemas, the proposal token codec, dependencies, and the error envelope.
- `src/voice_agent_api/agent`: the text agent ([plan 0003](../../docs/plans/0003-text-agent-orchestration.md), [ADR 0007](../../docs/decisions/0007-agent-orchestration-and-tool-boundary.md)): typed allow-listed tools, a LangGraph turn graph, a bounded in-memory conversation store with process-scoped idempotency, and a provider-neutral model factory (`providers.py`; [ADR 0008](../../docs/decisions/0008-model-provider-adapter-and-selection.md)). It can read and prepare a review but cannot write. `POST /v1/agent/turns` answers 503 `agent_unavailable` while `AGENT_PROVIDER=disabled` (the default); tests drive it with a scripted model or a real `ChatGroq` over a mock transport and need no network or key.
- `src/voice_agent_api/factory.py`: builds the app from explicit parts. `main.py` is the entrypoint that loads settings and `.env`.
- `src/voice_agent_api/config.py`, `devtools/secrets.py`, `demo_reset.py`: validated settings, local secret generation and checking, and the demo reset.
- `supabase/migrations`: the schema, catalog seed and API role, created with the Supabase CLI.
- `openapi.json`: generated contract, checked by a test.
- `tests/integration`: database tests, excluded unless run with `-m integration`.
- `tests/agent`, `tests/evals`: offline agent tests and the replay of `evals/agent/scenarios` (see [evals/README.md](../../evals/README.md)).

Copy `.env.example` to `.env` only if you need non-default settings; it holds placeholders only.
