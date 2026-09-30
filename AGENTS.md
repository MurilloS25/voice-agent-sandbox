# Voice Agent Sandbox agent guide

## Mission

Build a portfolio-quality, browser-based voice agent for a fictional service business. The demo must prove reliable tool use, observable decisions, safe state changes, and thoughtful voice UX without processing real customer data.

## Canonical sources

Read these before non-trivial work:

1. `README.md` for product scope.
2. `docs/ARCHITECTURE.md` for boundaries and provisional decisions.
3. The closest tests, schemas, and package documentation for the code being changed.

If documentation and executable behavior disagree, call out the conflict and update the stale source in the same change when appropriate.

## Product invariants

- Use fictional business and customer data only.
- Do not retain raw audio. Persist text, structured events, and timing metadata only when required by the feature.
- A model never writes directly to storage. State changes go through typed application tools.
- Creating, rescheduling, or canceling an appointment requires an explicit user confirmation at the final step.
- Tool calls must be idempotent where retries are plausible and must emit an auditable result.
- Clearly distinguish what the user said, what the model inferred, and what a tool confirmed.
- Degrade to text gracefully when microphone, speech recognition, synthesis, or provider services are unavailable.

## Intended repository shape

- `apps/web`: Next.js user interface and browser voice adapter.
- `apps/api`: FastAPI application, agent orchestration, and domain tools.
- `packages/contracts`: provider-neutral schemas shared across boundaries when the codebase needs them.
- `evals`: version-controlled conversation scenarios and evaluation criteria.
- `docs`: architecture, decisions, and active implementation plans.

Do not create abstractions or packages merely to match this outline. Add a boundary only when the implemented slice needs it.

## Engineering rules

- Deliver vertical slices: UI or API entry point, domain behavior, validation, observable result, and focused tests.
- Keep transport, agent orchestration, and appointment-domain logic separate.
- Represent conversation and tool state with explicit typed schemas; avoid unstructured dictionaries crossing layers.
- Put provider-specific speech or model code behind small adapters.
- Validate tool inputs server-side even if the model produced them.
- Use UTC internally and make the fictional business timezone explicit at presentation boundaries.
- Never log secrets, raw authorization headers, or unredacted sensitive text.
- Prefer deterministic code for validation, availability, pricing, and appointment rules. Use the model for language understanding and response composition.

## Workflow

1. Inspect the relevant code and documentation before proposing a change.
2. For work spanning multiple boundaries, create a concise plan in `docs/plans/` using its template.
3. Implement the smallest end-to-end behavior that produces user-visible or measurable value.
4. Add or update tests at the layer where the behavior belongs.
5. Run the narrow checks first, then the broader available checks.
6. Review the diff for privacy, confirmation, idempotency, and observability regressions.
7. Record lasting architecture decisions in `docs/decisions/`.

Until build tooling exists, do not invent commands. When scaffolding adds commands, update `docs/HARNESS.md` in the same change.

## Definition of done

A change is complete when its behavior is testable, failure states are handled, relevant documentation is current, no real personal data or secrets were introduced, and the final report names the checks actually run. Never claim a check passed if it was not executed.
