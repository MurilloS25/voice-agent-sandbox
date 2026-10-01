# The text agent reads and proposes; it never writes, and one process owns its conversations

- Status: accepted
- Date: 2026-10-01

## Context

Milestone 3 adds a conversational agent in front of the booking domain. The model is untrusted: its tool names and arguments are guesses, visitor text may contain instructions, the provider can be slow or fail, and a response can be lost between the API and the browser. Bookings must still be created only by the user's explicit confirmation through the signed-proposal flow ([ADR 0004](0004-signed-proposals-and-stale-detection.md)). Persistence of conversations is deferred, and this phase has no model provider (a scripted model drives every test).

## Decision

**Orchestration.** A hand-written LangGraph `StateGraph` with two nodes (`agent`, `tools`) runs one turn. There is no checkpointer, no `interrupt()` and no `create_agent`: the human confirmation is outside the graph. Budgets per turn: 4 model calls, 3 tool executions (at most one `prepare_booking_review`), recursion limit 10. A failure inside a node records an event and ends the turn degraded; it never raises out of the graph.

**Tools (allow-list).** `get_business_info`, `list_services`, `find_available_slots`, `prepare_booking_review`. Every argument is validated server-side (`extra="forbid"`, patterns, ranges). The model selects a slot only by `slot_id` (`S1` to `S10`) from the server's most recent offer, and `propose_appointment` plus `check_slot` re-validate it. There is no confirm, cancel or reschedule tool. The agent receives a `ReadOnlyAppointmentBook` whose `confirm` and `get` raise, and a static test forbids any reference to `confirm_appointment` or `.confirm` in the package, to storage adapters, to the network, or to a provider SDK.

**Token boundary.** The proposal token is an opaque capability. It is never sent to the model (not in the prompt, history or any tool result), and never in timeline events, logs, URLs or visible text. It appears only in the typed `booking_review` field of the turn response and in the existing `ConfirmForm` hidden input, because the browser must return it to confirm. The store keeps it only inside the committed, cached response. Expiry, signature, fingerprint and revalidation are unchanged.

**Idempotency (client-generated conversation id).** Each request carries `conversation_id`, `client_turn_id` (the idempotency key), `turn_index` and `message`. The store checks, in order: key reuse (a different conversation, message or index is `409 idempotency_key_reused`, never a silent retry), a committed turn (replayed exactly, no model call), an in-flight turn (`409 turn_in_progress`), a retained tombstone (`410`), an unknown conversation (`turn_index == 1` creates it, otherwise `404`), a different turn in flight (`409 conversation_busy`), the 30-turn limit and the expected index. Every committed turn is cached for the conversation's life, so an earlier turn can be retried after later ones. The guarantee is **process-scoped**: it covers the conversations, caches, global index and tombstones that this API process still holds. After a restart, or once a tombstone has left the bounded FIFO, a first turn is indistinguishable from a new conversation and may call the model again. It still cannot create an appointment. Cross-restart exactly-once processing needs persisted conversation and idempotency state and is deferred.

**Atomic commit.** A turn works on a working copy (events, offered slots, at most one review). Exactly one `commit_turn(turn_token, …)` records the response and the state changes under the store lock, and only for the matching `turn_token`. `abort_turn` is token-checked too: for an existing conversation it clears the in-flight marker and the uncommitted key, for one created by the failed request it removes the conversation without a tombstone. A refused or failed commit aborts, so in-flight markers never leak. Abandoned (late) model or tool calls only return values to a discarded future.

**Errors.** Once a turn is accepted the API answers 200 (`completed` or `degraded`) and caches the response. Non-200 means nothing was accepted (422, 503 `agent_unavailable` when no provider is configured, 404, 410, 409, 429 `agent_busy`). A provider failure, a deadline, a budget limit or a catalog/appointment storage failure during an accepted turn is a degraded 200 with a sanitized event, and consumes the turn number. A review prepared before such a failure is returned explicitly with a fixed notice, so the visitor never has a hidden pending review and `booking_review_ready` always has a matching `booking_review`.

**Timeouts.** No automatic provider retries. Each model call, tool call and the prompt catalog read waits at most `min(per-call limit, time left)` through a `BoundedCaller` and is not started with under 1 s left. Defaults: deadline 20 s, model call 8 s, tool call 7.5 s (at least the 7 s database worst case of [ADR 0002](0002-direct-postgres-private-schema.md)), plus 1 s to commit: a 21 s server bound, and 26 s for the web client (same 5 s margin as booking requests). Without the deadline the calls could total 62 s. `tests/test_timeout_budget.py` recomputes this from the real defaults.

**Limits, stated honestly.** `BoundedCaller` stops waiting; it cannot cancel a blocking HTTP or database call. An abandoned call runs on in its worker (a dedicated pool of 8) until its own timeouts end it, and an abandoned database read holds a pool connection meanwhile. httpx timeouts are per phase, not total. The 4-turn in-process cap keeps this far below the FastAPI threadpool (default 40), whose admission is not bounded by the app. Conversations, the global cap and the semaphore are process-local; several workers would each keep their own.

The pool's threads are not daemons, so a call still blocked at process exit can delay exit until its own provider or database timeout ends it. The agent is opened and closed by the app's lifespan. A model message is limited to `max_tool_calls` calls (valid ones first, extras dropped with one guardrail event) and every kept call gets an id, so every tool call has a paired result and a model cannot grow a turn's events. If building the response itself fails (a bug), the turn degrades to a fixed response without a review, and the validation error text, which could include the token, is never logged.

**Residual risks.** Nothing filters the model's wording: a model could say a booking is made, although it cannot make one and the review notice, the prompt and the live evaluation (a later phase) all say otherwise. Request validation (422) runs before the "provider disabled" check (503), so an invalid body gets 422 even when the agent is off.

**Sessions and events** live in memory behind a `ConversationStore` port: 30 minutes idle, at most 200 conversations (the least recently active idle one is evicted; in-flight ones never are; if all are in flight a new one gets 429), 30 turns, 16 history entries, 1,000 tombstones. Cleanup runs under the store lock inside `begin_turn`, with no background task. Eviction and expiry delete cached responses, history, the review summary and index entries together.

**Identifier taxonomy** (corrected after the first live smoke, where a provider-generated, UUID-shaped `tool_call_id` tripped an over-broad "no UUID in provider traffic" assertion). Four surfaces and three kinds of identifier:
- *Public surfaces*: timeline events, the reply text, logs, URLs and the visible transcript. They hold no identifier of any kind.
- *The private provider protocol*: the messages sent to the model. A provider-generated `tool_call_id` is **allowed here and only here**, because the next request must pair each tool result with the tool call that asked for it. It is opaque protocol correlation data, may be UUID-shaped, is never stored in a conversation (only text is kept), and is never part of `AgentTurnResponse`.
- *Application and domain identifiers* (conversation id, client turn id, proposal id, appointment id, bench or database ids) are **forbidden on every surface above**, provider traffic included.
- The proposal token stays authorized only in `booking_review` and the confirm form's hidden field.
`tests/agent/privacy.py` encodes this as an audit (`audit()`), used by the offline tests and the live evaluation. It masks only the correlation-id fields of the provider messages, so a UUID-shaped string anywhere else in provider traffic, or a correlation id on a public surface, is still a violation. A violation is reported as a surface and an identifier type (for example `logs:provider_tool_call_id`), never as the matched value.

**Observability.** The timeline holds user text, the assistant's visible text, validated tool inputs, fixed codes, durations and short summaries composed by the code. Model reasoning is never read (only `.content`, with `<think>` blocks stripped) and exception text is never used. The per-turn log line has counts only.

## Consequences

- The booking write path is unchanged and unreachable from the agent. The route, schema and generated types are additive.
- Retries are safe while the process is up; a restart loses conversations (later turns get 404, the web shows "start a new conversation").
- The system prompt is rebuilt each turn from a fresh catalog read and the conversation's structured state, so tool results are not replayed across turns.
- Provider adapters, live evaluation and the web chat are separate phases (3B, 3C).

## Alternatives considered

- **`create_agent` and `HumanInTheLoopMiddleware`:** more than one booking flow needs, and the human step is already the confirm button.
- **LangGraph checkpointers (`InMemorySaver`, `PostgresSaver`):** `PostgresSaver` runs its own DDL, which conflicts with the least-privilege private schema ([ADR 0002](0002-direct-postgres-private-schema.md)); an own typed store holds exactly what is chosen.
- **A create-conversation endpoint, or a global index for null conversation ids:** more state and a round trip for the same retry guarantee.
- **Hard cancellation of provider calls:** not possible for synchronous third-party calls; the design makes late results harmless instead.
- **Discarding a review when a turn degrades:** the review is valid deterministic output and the visitor can still decline it.
