# API

FastAPI backend for Voice Agent Sandbox. It serves fictional business data and deterministic availability from an in-memory adapter.

Commands are listed in [docs/HARNESS.md](../../docs/HARNESS.md). Layout:

- `src/voice_agent_api/domain`: framework-free models, availability rules, and ports.
- `src/voice_agent_api/infrastructure`: in-memory adapters and the fictional seed data.
- `src/voice_agent_api/api`: routes, response schemas, dependencies, and the error envelope.
- `openapi.json`: generated contract, checked by a test.
