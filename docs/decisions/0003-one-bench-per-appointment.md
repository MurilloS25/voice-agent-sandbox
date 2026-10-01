# Each appointment holds one bench, enforced by an exclusion constraint

- Status: accepted
- Date: 2026-09-30

## Context

The workshop has two benches. Milestone 1 treated capacity as peak concurrency: a job fit if fewer than two bookings overlapped it at every instant, so two back-to-back jobs could "share" capacity across different benches. That cannot be enforced by the database, and two concurrent confirmations could both pass an application-level check.

## Decision

- Every appointment is assigned one bench (`bench_no`) for its whole duration. A job fits only when a single bench is free throughout.
- `appointments_no_bench_overlap` is a PostgreSQL exclusion constraint: `EXCLUDE USING gist (business_id WITH =, bench_no WITH =, during WITH &&) WHERE (status = 'confirmed')`, where `during` is a generated `tstzrange(starts_at, ends_at, '[)')`. It needs the `btree_gist` extension.
- Intervals are half-open `[start, end)`: an appointment ending exactly when another starts does not overlap it. Times are stored as `timestamptz` (UTC); the business timezone is applied only at presentation boundaries, and `check_slot` keeps the existing DST rules.
- Confirmation takes a transaction-scoped advisory lock, `pg_advisory_xact_lock`, keyed by the business and its local calendar day. The key is the 8-byte BLAKE2b digest read as a signed 64-bit integer, so it is deterministic and always inside PostgreSQL's bigint range (never Python's randomized `hash()`).
- Under the lock the adapter reads the day's bookings, re-runs every availability rule, takes the lowest-numbered free bench and inserts. The constraint is the backstop: an exclusion violation maps to `slot_unavailable`.
- This supersedes the peak-concurrency rule from the foundation milestone. Availability and confirmation share `free_bench`, so what is offered is what can be booked.

## Consequences

- Double booking is impossible even for a writer that skips the lock. The lock makes bench allocation deterministic, so there are no retry loops.
- Fragmented days can offer slightly fewer slots than peak concurrency would (for example, a 45-minute job spanning two different benches' bookings is no longer offered).
- A lock collision between unrelated days could only add waiting, never a wrong result.
- Cancellation (later) frees a bench by changing `status`, which drops the row out of the constraint.

## Alternatives considered

- **Constraint alone, retrying on violation:** correct, but allocation becomes catch-and-retry.
- **SERIALIZABLE isolation with retry on 40001:** correct, but opaque, prone to false aborts and harder to test.
- **Lock plus application check, no stored bench:** the database cannot enforce capacity.
- **Peak concurrency with rebalancing:** the database could enforce it, but only by rewriting other rows on every confirmation.
- **`SELECT … FOR UPDATE` on a business row:** needs an UPDATE privilege the API role should not have.
- **PostgreSQL 18 `WITHOUT OVERLAPS`:** Supabase ships PostgreSQL 15 and 17.
