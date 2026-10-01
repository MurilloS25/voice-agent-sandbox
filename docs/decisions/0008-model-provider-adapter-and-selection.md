# The model provider sits behind a neutral factory; the model is chosen by criteria, not in code

- Status: draft
- Date: 2026-10-01

## Context

The text agent ([ADR 0007](0007-agent-orchestration-and-tool-boundary.md)) needs a chat model that supports tool calling. The provider is external and variable: models are renamed, preview models are not meant for production, and Groq's own documentation disagreed with itself when this was researched (the models page listed two Llama models that its deprecations page said were shut down on 2026-08-16). A key is a secret ([ADR 0006](0006-secret-provisioning-and-validation.md)), and the free tier is small (8K tokens per minute per model, per Groq's rate-limit page).

## Decision

- **A neutral factory.** `agent/providers.py` returns a `langchain_core` `BaseChatModel` (or `None`) from settings. It is the only module that knows a vendor, and it imports `langchain_groq` inside the builder, so a disabled provider never loads it. A static test enforces both.
- **Disabled by default.** `AGENT_PROVIDER=disabled|groq`. While disabled, the application and `secrets check` need no key and no model, placeholders in `.env` are ignored, and `POST /v1/agent/turns` answers 503.
- **Fail closed, names only.** With `groq`, a missing, empty or placeholder `GROQ_API_KEY` (or one containing whitespace) and a missing, placeholder or malformed `AGENT_MODEL` stop startup with the fixed message "Server configuration is invalid." Only the setting names are logged. No key format is assumed, because none has been verified from Groq's documentation.
- **No model id in code.** `AGENT_MODEL` has no default. `.env.example` holds placeholders only.
- **Bounded, no retries.** The client is built with `timeout` set to the per-call limit (8 s) and `max_retries=0`, so a 429 or 5xx costs exactly one request. That timeout is httpx's per-phase timeout (connect, read, write, pool), not a total one, so the turn deadline and `BoundedCaller` of ADR 0007 remain the real bound. `AGENT_TEMPERATURE` (0), `AGENT_MAX_OUTPUT_TOKENS` (512) and `AGENT_REASONING_EFFORT` (low, or `off` to send none) are settings.
- **Reasoning stays out.** `AGENT_REASONING_CONTROL` sends `include_reasoning=false` (the gpt-oss family) or `reasoning_format=hidden` (the qwen family), per Groq's reasoning documentation, where the two cannot be combined. Whatever is set, the graph drops `reasoning_content` and `reasoning` from every model message before it is stored, replayed or shown, and strips `<think>` blocks from visible text.
- **Errors by code, never by message.** Adapters may raise `ProviderError`. Otherwise an HTTP-style `status_code` and exception class names map to the event codes: 429 rate limited; a timeout class, 408 or 504 timeout; 400 or 422 bad output (for example a failed tool call); everything else unavailable. A 400 caused by bad configuration (an invalid reasoning option) therefore shows as bad output, and a wrong `AGENT_MODEL` (404) as unavailable; the live smoke test is where those are found.
- **The endpoint is pinned.** `base_url` is the constant `https://api.groq.com`, so a stray `GROQ_API_BASE` or `GROQ_BASE_URL` in the host environment cannot redirect the key and the visitors' text. (httpx still honors `HTTP_PROXY` and `HTTPS_PROXY`; a proxy is a deployer decision.)
- **Tracing is refused.** LangSmith tracing would send prompts, visitor text and tool results to a third party. If `LANGSMITH_TRACING`, `LANGSMITH_TRACING_V2`, `LANGCHAIN_TRACING_V2` or `LANGCHAIN_TRACING` is truthy when the adapter is built, startup fails, naming only the variable.
- **Provider payloads are never logged.** The Groq SDK logs whole request bodies at DEBUG, so building the adapter pins the `groq`, `httpx` and `httpcore` loggers to WARNING, whatever the root logger is set to.
- **Dependencies** (versions resolved on 2026-10-01): `langchain-groq` 1.1.3 (requires `langchain-core>=1.4,<2` and `groq>=0.30,<1`) and its `groq` SDK 0.37.1. The SDK's newest release is 1.7.0, but `langchain-groq` does not allow it yet. The top-level `langchain` package is not installed.

### Choosing a model (not yet done)

No model is selected. Before the first live call it is chosen from Groq's pages on that day, by these criteria: a production (not preview) model on the models page that is not on the deprecations page, tool use supported, a context window of at least 32K tokens, listed free-tier limits that fit the evaluation plan, 100% of safety scenarios and at least 90% of task scenarios in the live evaluation, and a median turn latency of 5 s or less. On 2026-10-01 the candidates were `openai/gpt-oss-120b` (primary) and `openai/gpt-oss-20b` (comparison). Both have no parallel tool calls, which suits one-step-at-a-time booking. Strict structured output cannot be combined with tool use or streaming, so server-side validation never depends on it. Record the choice, the date and the evidence here before this ADR is accepted.

## Consequences

- The agent can be developed, tested and demonstrated offline: tests drive a real `ChatGroq` over an injected mock HTTP transport, asserting the request body (model, token and temperature limits, tools, reasoning controls, key only in the `Authorization` header), the error mapping and the single-request guarantee.
- Groq retains inference data for up to 30 days for abuse monitoring unless Zero Data Retention is enabled in the console (Groq's data-controls page). Only fictional business data and visitor-typed chat text are sent.
- Switching provider means a new branch in the factory and a classification review; orchestration, tools and tests do not change.
- A key leak is handled by revoking it in the provider console and restarting.

## Alternatives considered

- **The OpenAI-compatible endpoint through a generic client:** it avoids a vendor package, but Groq rejects some parameters (for example `logprobs`) and the tool-calling message conversion would be hand-written.
- **SDK retries (the default of two):** they can multiply the time of a call beyond the turn deadline and spend free-tier tokens on repeats.
- **Hard-coding a default model:** it goes stale silently; a missing setting fails closed instead.
- **Streaming:** not needed for request/response turns, and Groq does not combine it with structured output.
