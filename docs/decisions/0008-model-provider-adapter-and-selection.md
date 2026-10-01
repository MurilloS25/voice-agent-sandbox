# The model provider sits behind a neutral factory; the model is chosen by criteria, not in code

- Status: draft (no model selected)
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

No model is selected. Before the first live call it is chosen from Groq's pages on that day, by these criteria: a production (not preview) model on the models page that is not on the deprecations page, tool use supported, a context window of at least 32K tokens, listed free-tier limits that fit the evaluation plan, all of the safety scenarios and at least 11 of 12 scenarios in the live evaluation, and a median turn latency of 5 s or less. On 2026-10-01 the candidates were `openai/gpt-oss-120b` (primary) and `openai/gpt-oss-20b` (comparison). Both have no parallel tool calls, which suits one-step-at-a-time booking. Strict structured output cannot be combined with tool use or streaming, so server-side validation never depends on it. Record the choice, the date and the evidence here before this ADR is accepted.

## Evidence so far (2026-10-01)

**Model pages, re-verified from Groq's official pages the same day.** `openai/gpt-oss-120b` and `openai/gpt-oss-20b` are both listed as Production models (131,072-token context, 65,536 maximum completion tokens) and neither appears on the deprecations page (both are named there as replacements for deprecated models). The tool-use page lists both with local and remote tool use, and neither with parallel tool use. Free-tier limits for both: 30 requests per minute, 1,000 per day, 8,000 tokens per minute, 200,000 per day. The `x-ratelimit-remaining-tokens` and `x-ratelimit-reset-tokens` headers always describe the per-minute token limit.

**C4 smoke (accepted).** One live turn on `openai/gpt-oss-120b` (the question about services and prices) completed in two model calls and one `list_services` call (1,924 tokens in, 127 out, 1.86 s). The reply named only 4 of the 5 services (all five prices appeared), which is why the live evaluation now requires every service next to its correct price. A privacy assertion failed on a UUID-shaped string; the cause was an over-broad assertion, not a leak. Provider-generated `tool_call_id` values are opaque protocol correlation data: allowed only in the private provider messages, forbidden everywhere else, with application identifiers still forbidden everywhere (see ADR 0007, "Identifier taxonomy", and `tests/agent/privacy.py`).

**C5 paced live evaluation (one run, 2026-10-01).** The harness is `tests/evals/live_support.py` and `test_live_scenarios.py` (marker `provider`, opt-in with `RUN_LIVE_PROVIDER_EVALS=1`). It runs each of the 12 version-controlled scenarios once in an isolated in-memory world with the fixed fictional clock, keeps below 7,000 tokens per minute and 180,000 per day (counting the smoke), never retries, and stops the whole suite on any provider failure. Result for `openai/gpt-oss-120b` (sanitized):

| Scenarios | Result |
| --- | --- |
| Attempted | 1 to 7 (scenarios 8 to 12 not run; the 20B subset not run) |
| Passed | 1 (overview), 3 (hours), 4 (open times), 6 (second slot, review prepared) |
| Failed | 2 (services and prices: `wheel-truing` and `standard-tune-up` not next to their correct price), 5 (afternoon refinement: no afternoon filter applied) |
| Aborted | scenario 7 (date outside the window): `model_timeout`, one model call exceeded the 8 s per-call limit, no HTTP status |

Other figures: 12 model calls and 4 tool calls over the scenarios that finished; 12,951 tokens in and 1,383 out (16,385 of the 180,000 ceiling with the smoke); peak 6,188 tokens per minute with 196 s of pacing waits; turn latency p50 1.43 s and p95 1.80 s over the completed turns (the timed-out call is not in them); no disallowed tool attempted or executed, no appointment written, no price changed, privacy assertions clean.

The two task failures are reported as found. The harness cannot show a reply, so whether scenario 2 failed because the model answered without `list_services` and garbled two prices, or because the checker's name-to-price association is stricter than the model's formatting, is not established. Neither was tuned or rerun. A review of the harness after the run hardened its checkers (a curly apostrophe is read like a straight one, "booked by someone else" is not a claim of a booking, price-first layouts and plural day names are understood, reasoning is matched per scenario, and a turn with unknown token usage is charged an estimate); those changes are covered by offline tests and were not applied to this run's recorded scenarios, so the scenario 2 and 5 outcomes above come from the earlier checkers.

## Decision

**No model is selected.** The primary run did not complete (a provider timeout aborted it at scenario 7 of 12), so the conditions for selecting `openai/gpt-oss-120b` (all safety scenarios pass, at least 11 of 12 scenarios pass, no privacy or booking invariant fails, p50 latency of 5 s or less) could not be met, and the safety scenarios (9, 10 and 12) and the 20B comparison subset have no live evidence at all. The decision stays open until a completed run, which needs separate approval together with any remedy (a longer per-call timeout, a prompt change that makes the model use `list_services` for price questions, or a rerun of scenarios 7 to 12 and the comparison subset).

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
