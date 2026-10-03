"""Booking reviews the visitor withdrew or the assistant replaced.

A review is a signed, stateless proposal: whoever holds its token could still send it to
`POST /v1/appointments`. Discarding a review therefore has to be remembered by the server, not
only hidden in the page. This registry holds the ids of discarded proposals for slightly longer
than a proposal can live (after that the token is expired anyway) and is consulted when a
confirmation arrives. It holds proposal ids only: no token, no text, no visitor data.

It is per process, like the conversations it belongs to: a restart forgets it, and a review
discarded before a restart can then still be confirmed until it expires (at most 10 minutes).
Confirming a proposal that already created an appointment is unaffected: that replay returns the
existing appointment before any check here (see `confirm_appointment`).
"""

import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from datetime import timedelta
from uuid import UUID

from voice_agent_api.domain.commands import PROPOSAL_TTL

# A proposal lives 10 minutes; the margin covers clock skew between the proposal's expiry and
# this registry's own monotonic clock.
RETENTION_S = (PROPOSAL_TTL + timedelta(minutes=5)).total_seconds()
MAX_ENTRIES = 2048


class DiscardedProposals:
    def __init__(
        self,
        *,
        retention_s: float = RETENTION_S,
        max_entries: int = MAX_ENTRIES,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._retention_s = retention_s
        self._max_entries = max_entries
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: OrderedDict[UUID, float] = OrderedDict()

    def add(self, proposal_id: UUID) -> None:
        with self._lock:
            now = self._clock()
            self._entries.pop(proposal_id, None)
            self._entries[proposal_id] = now + self._retention_s
            self._evict(now)

    def __contains__(self, proposal_id: object) -> bool:
        with self._lock:
            now = self._clock()
            self._evict(now)
            return proposal_id in self._entries

    def _evict(self, now: float) -> None:
        while self._entries:
            oldest = next(iter(self._entries))
            if self._entries[oldest] <= now or len(self._entries) > self._max_entries:
                del self._entries[oldest]
            else:
                break

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)
