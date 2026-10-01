# Bookings are confirmed from a signed proposal that is re-derived, never trusted

- Status: accepted
- Date: 2026-09-30

## Context

A booking must be created only after the user has seen exactly what will happen and explicitly confirmed it, and a retry or a double click must never create a second appointment. Authentication is deferred, so tampering and replay still have to be handled. A future agent may propose bookings, but only a user action may confirm them.

## Decision

- **Propose, then confirm.** `POST /v1/appointment-proposals` validates a slot and returns the review (service, local date and time, duration, timezone, price, a fictional alias) plus a signed token. It writes nothing. `POST /v1/appointments` with `confirm: true` (the boolean `true`, not `1`) is the only write.
- **The token is `v1.<payload>.<HMAC-SHA256>`** with a 10-minute lifetime. The payload is exactly `{v, pid, svc, start, exp, fp}`. The signature is verified in constant time before the payload is parsed, parsing is strict, and unknown keys are rejected. No end time, business, alias, bench, duration, price or service snapshot is carried.
- **Everything stored is recomputed** from a freshly read catalog inside the locked transaction: business id, end time, price context, alias (a pure function of the proposal id) and bench. Only the proposal id, service id, start and expiry are inputs.
- **`fp` is a comparison value, never an input.** It is a 128-bit SHA-256 digest of the values the user reviewed: business id, timezone and currency, and the service's id, name, duration, price amount and price currency. On confirm it is recomputed from the fresh catalog and compared in constant time. A mismatch, or a removed service, returns **409 `proposal_stale` and writes nothing**, so the booking written is the booking reviewed or nothing is written. Hours, slot grid, lead time, horizon and bench count are not fingerprinted, because `check_slot` re-validates them (a change yields `slot_not_offered` or `slot_unavailable`, never a different booking).
- **Idempotency key = proposal id.** `appointments.proposal_id` is unique. A replay returns the original appointment (200, identical body) without calling the decision logic, even after expiry or a catalog change. This holds because the appointment row stores a snapshot of what was booked (service name, price, currency and the business timezone; the duration is end minus start), and the API renders the response from that row alone, with no catalog read after the write. `tests/api/test_appointments.py` changes the name, duration and price and asserts the whole replayed body, and the appointment read-back, are unchanged. Order of checks on confirm: replay, expiry, staleness, slot availability.
- **Error semantics:** 409 for conflicts with current state (`slot_unavailable`, `proposal_stale`), 422 for invalid input (`proposal_invalid`, `proposal_expired`, `slot_not_offered`), 503 `storage_unavailable` when storage is unreachable. The structured error envelope is unchanged.
- **CSRF, tampering, replay.** Confirm is reached only from a Next.js Server Action, which checks `Origin` against `Host` (a missing `Origin` is allowed with a warning). With no authentication or cookies, the worst a forged request can do is book a fictional slot. A forged or altered token fails its signature. Rate limiting is required before any public deployment.

## Consequences

- No pending rows to expire and no capacity held during review, so abandoned reviews cost nothing. The price is that a slot can be taken during review, which is an expected, designed-for conflict state.
- A signing key is a server secret, validated at startup (see ADR 0006). Rotating it invalidates outstanding reviews, which is acceptable for 10-minute tokens.
- The catalog is read per request, so a catalog change is detected immediately rather than at the next restart.

## Known limitation: idempotency is per proposal, not per visitor

- Idempotency is scoped to a proposal id (the token). Double clicks, retries after a timeout and replays of the same review always return the one appointment.
- Reloading the review page, or navigating Back to it, generates a fresh review with a new proposal id. Confirming that fresh review can create a second appointment if a bench is still free. This is not the same token producing a duplicate, and a confirmed booking does not disappear.
- With no user identity, account ownership or business idempotency key, the system cannot tell that two proposals came from the same visitor. Cross-proposal deduplication by identity is deferred to a later milestone.

## Alternatives considered

- **A persisted pending hold:** reserves capacity but needs expiry sweeps, and abandoned holds block slots.
- **A plain POST of `{service, start}` with an `Idempotency-Key` header:** nothing binds what was reviewed to what is booked. The IETF idempotency-key draft has also expired.
- **Carrying end time, alias and bench in the token:** signed but still derived data; recomputing removes a class of tampering and drift bugs.
