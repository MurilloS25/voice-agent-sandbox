"""Token-bucket rate limits that live in this process's memory (plan 0007, section D).

One API instance means these counters are exact. They are bounded (`max_buckets`), expire by
themselves (a bucket that has been idle long enough to be full again is indistinguishable from a
new one, so it is dropped) and are cleaned up inside `take`, with no background task. The clock is
injected so tests never sleep. A client key is an opaque string: it is never logged and never
stored anywhere but here.
"""

import math
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum


class Category(StrEnum):
    """What a request costs, which decides the limit that applies to it."""

    AGENT = "agent"  # a model turn: the expensive one
    SPEECH = "speech"  # a transcription
    WRITE = "write"  # proposals and confirmations
    READ = "read"  # business, services, availability, an appointment


@dataclass(frozen=True)
class Policy:
    """`per_min` tokens are added every minute; a bucket holds at most `burst`."""

    per_min: int
    burst: int

    def __post_init__(self) -> None:
        if self.per_min < 1 or self.burst < 1:
            raise ValueError("A rate limit needs a positive rate and burst.")

    @property
    def refill_per_s(self) -> float:
        return self.per_min / 60.0

    @classmethod
    def per_minute(cls, per_min: int) -> "Policy":
        """A rate with a burst of half a minute's worth (at least one)."""
        return cls(per_min=per_min, burst=max(1, math.ceil(per_min / 2)))


@dataclass
class _Bucket:
    tokens: float
    updated: float


class TokenBuckets:
    """Many buckets by key under one lock. `take` returns None when the request may go ahead,
    or the whole seconds to wait (at least 1) when it may not."""

    def __init__(self, clock: Callable[[], float], *, max_buckets: int = 5000) -> None:
        if max_buckets < 1:
            raise ValueError("max_buckets must be positive.")
        self._clock = clock
        self._max = max_buckets
        self._buckets: OrderedDict[str, _Bucket] = OrderedDict()
        self._lock = threading.Lock()

    def __len__(self) -> int:
        with self._lock:
            return len(self._buckets)

    def take(self, key: str, policy: Policy) -> int | None:
        now = self._clock()
        with self._lock:
            self._expire(now, policy)
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = _Bucket(tokens=float(policy.burst), updated=now)
                self._buckets[key] = bucket
            else:
                self._refill(bucket, now, policy)
            self._buckets.move_to_end(key)
            self._evict_overflow()
            if bucket.tokens >= 1.0:
                bucket.tokens -= 1.0
                return None
            missing = 1.0 - bucket.tokens
            return max(1, math.ceil(missing / policy.refill_per_s))

    def give_back(self, key: str, policy: Policy) -> None:
        """Return one token (a request that was stopped by a later check did not cost this one)."""
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is not None:
                bucket.tokens = min(float(policy.burst), bucket.tokens + 1.0)

    @staticmethod
    def _refill(bucket: _Bucket, now: float, policy: Policy) -> None:
        elapsed = max(0.0, now - bucket.updated)
        bucket.tokens = min(float(policy.burst), bucket.tokens + elapsed * policy.refill_per_s)
        bucket.updated = now

    def _expire(self, now: float, policy: Policy) -> None:
        """Drop buckets that have been idle for as long as a full refill takes. Entries are in
        least-recently-used order, so the scan stops at the first one that is still live."""
        full_after = policy.burst / policy.refill_per_s
        while self._buckets:
            key, bucket = next(iter(self._buckets.items()))
            if now - bucket.updated < full_after:
                break
            del self._buckets[key]

    def _evict_overflow(self) -> None:
        while len(self._buckets) > self._max:
            self._buckets.popitem(last=False)  # the least recently used


@dataclass(frozen=True)
class CategoryLimits:
    client: Policy
    overall: Policy


class RateLimits:
    """Per-client and overall limits for each category. A request must pass both.

    The client check comes first and the overall bucket is touched only when the client may
    proceed, so one noisy client cannot use up the shared allowance by being refused."""

    def __init__(
        self,
        limits: dict[Category, CategoryLimits],
        clock: Callable[[], float],
        *,
        max_clients: int = 5000,
    ) -> None:
        missing = set(Category) - set(limits)
        if missing:
            raise ValueError("Every category needs a limit.")
        self._limits = limits
        self._clients = {c: TokenBuckets(clock, max_buckets=max_clients) for c in Category}
        # One shared bucket per category: a single key.
        self._overall = {c: TokenBuckets(clock, max_buckets=1) for c in Category}

    def check(self, category: Category, client_id: str) -> int | None:
        """None when allowed, otherwise the seconds to wait."""
        rule = self._limits[category]
        wait = self._clients[category].take(client_id, rule.client)
        if wait is not None:
            return wait
        wait = self._overall[category].take("*", rule.overall)
        if wait is not None:
            self._clients[category].give_back(client_id, rule.client)
            return wait
        return None

    def tracked_clients(self) -> int:
        return sum(len(buckets) for buckets in self._clients.values())
