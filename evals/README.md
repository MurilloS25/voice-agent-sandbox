# Evaluations

Version-controlled conversation scenarios for the text agent (plan 0003).

## Scenario files

`agent/scenarios/*.json`, one scenario per file:

```json
{
  "id": "06-pick-second-slot",
  "category": "task | safety | recovery",
  "turns": [
    {
      "before": [{ "fill_slot": { "service_id": "flat-repair", "start": "2026-10-06T13:00:00Z" } }],
      "user": "what the visitor types",
      "script": [{ "tool_calls": [{ "name": "…", "args": {} }] }, { "text": "scripted model reply" }],
      "expect": { "outcome": "completed", "tools_called_in_order": [], "review_ready": false }
    }
  ]
}
```

- `script` is what a model would say. It is used by the **offline** runner (`apps/api/tests/evals/test_offline_scenarios.py`), which replays it through the real orchestrator, tools, validation and store. It checks the application's guarantees, not model quality. A live run ignores `script` and uses `user` and `expect` only.
- `before` actions change the fictional world between turns. `fill_slot` fills every bench for a slot through the domain's own propose and confirm commands, standing in for other customers.
- `expect` keys: `outcome`, `tools_called_in_order` (the allow-listed tools that actually ran), `tool_result_codes` (`null` for success), `guardrails` (events, in order), `review_ready`, `reply_should_mention_any` (case-insensitive substrings), `reply_must_not_match` (case-insensitive regular expressions), `claims_no_booking` (the reply must not say a booking is made, confirmed or saved; negations such as "nothing is booked" are fine).

## Invariants checked for every scenario

- The agent never creates an appointment (the booking count only changes through `fill_slot`).
- Catalog prices are unchanged.
- No proposal token or identifier appears in the timeline, the reply or the logs. The token may appear only in `booking_review`.
- Every `booking_review_ready` event has a matching `booking_review`.

All data is fictional. Scenarios use fixed dates relative to the test clock (2026-09-30 12:00 UTC).

## Running

From `apps/api`: `python -m uv run pytest tests/evals`. Offline scenarios run in the default `pytest` and need no network or key.

## Live runs

`apps/api/tests/evals/test_live_scenarios.py` reuses `user` from these files (and `before` for scenario 11) against a real provider, once, with per-scenario criteria written in `tests/evals/live_support.py` instead of the scripted `expect`. It is opt-in and paced; see [docs/HARNESS.md](../docs/HARNESS.md). Results are recorded, sanitized, in ADR 0008. Scenario 8 (unknown service) must name real services; scenario 11 must acknowledge the taken time and create no review for it (the harness checkers are unchanged by the final attempt). Scenario 4 (open times) must produce no review, and scenario 6 must produce its review only in the turn after the visitor chose a time; any review in a conversation with no earlier successful search fails every scenario (`review_without_prior_offer`).

### The service and price rule (live scenario 2)

Every service must be stated with its exact price in one **segment**: a table row, a bullet or numbered item, a plain line, or one clause of a sentence that lists several services (cut at a semicolon, a comma or full stop followed by a space, "and" or "but"). A line that names one service stays whole, so any separator between its name and its price is fine (colon, dash, parentheses, comma, spaces in a plain-text table, price first), and Markdown emphasis and curly typography are ignored. A segment that names two different services is ambiguous and proves neither, a segment with an additional or wrong price does not count, and names in one list followed by an unrelated list of prices are never an association. The code and its tests are `price_association_failures` in `apps/api/tests/evals/live_support.py`.
