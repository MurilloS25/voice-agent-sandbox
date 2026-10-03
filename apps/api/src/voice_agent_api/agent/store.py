"""In-memory conversation store with process-scoped idempotency.

Everything below is held by this process only. Turn processing is idempotent within the lifetime
and retained state of one API process: after a restart, or once a tombstone has left the bounded
FIFO, a first turn is indistinguishable from a new conversation (see plan 0003 and ADR 0007).

One lock guards every read, mutation and cleanup. There is no background task: expiry and
eviction run inside `begin_turn`.
"""

import hashlib
import json
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Protocol
from uuid import UUID, uuid4

from voice_agent_api.agent.contracts import MAX_TURNS, AgentTurnRequest, AgentTurnResponse
from voice_agent_api.agent.errors import (
    AgentBusy,
    ConversationBusy,
    ConversationExpired,
    ConversationLimitReached,
    ConversationNotFound,
    IdempotencyKeyReused,
    TurnInProgress,
    TurnOutOfOrder,
)
from voice_agent_api.agent.state import (
    ConversationSnapshot,
    ConversationUpdate,
    HistoryEntry,
    OfferedSlot,
    PendingReview,
)

MAX_HISTORY_ENTRIES = 16


@dataclass(frozen=True)
class Cached:
    """A committed turn's exact response, returned without calling the model."""

    response: AgentTurnResponse


@dataclass(frozen=True)
class Accepted:
    conversation_id: UUID
    turn_token: UUID
    snapshot: ConversationSnapshot


class ConversationStore(Protocol):
    def begin_turn(self, request: AgentTurnRequest) -> Cached | Accepted:
        """Return a cached response or accept the turn. Rejections raise typed errors and
        consume nothing."""
        ...

    def commit_turn(
        self,
        conversation_id: UUID,
        turn_token: UUID,
        response: AgentTurnResponse,
        update: ConversationUpdate,
    ) -> bool:
        """Atomically record the turn. False (and no change) if `turn_token` is stale."""
        ...

    def abort_turn(self, conversation_id: UUID, turn_token: UUID) -> bool:
        """Release an accepted but uncommitted turn so an identical retry is accepted anew.
        Acts only for the matching `turn_token`; otherwise a no-op returning False."""
        ...


def fingerprint(request: AgentTurnRequest) -> str:
    canonical = json.dumps(
        {
            "c": str(request.conversation_id),
            "i": request.turn_index,
            "m": request.message,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class _CommittedTurn:
    client_turn_id: UUID
    fingerprint: str
    response: AgentTurnResponse


@dataclass(frozen=True)
class _InFlight:
    client_turn_id: UUID
    fingerprint: str
    turn_token: UUID


@dataclass
class _Entry:
    conversation_id: UUID
    last_active: datetime
    committed: list[_CommittedTurn] = field(default_factory=list)
    history: tuple[HistoryEntry, ...] = ()
    offered: tuple[OfferedSlot, ...] = ()
    pending_review: PendingReview | None = None
    in_flight: _InFlight | None = None


class InMemoryConversationStore:
    def __init__(
        self,
        clock: Callable[[], datetime],
        *,
        idle_ttl: timedelta = timedelta(minutes=30),
        max_conversations: int = 200,
        max_turns: int = MAX_TURNS,
        max_tombstones: int = 1000,
        token_factory: Callable[[], UUID] = uuid4,
    ) -> None:
        self._clock = clock
        self._idle_ttl = idle_ttl
        self._max_conversations = max_conversations
        self._max_turns = max_turns
        self._max_tombstones = max_tombstones
        self._token_factory = token_factory
        self._lock = threading.Lock()
        self._entries: dict[UUID, _Entry] = {}
        # client_turn_id -> conversation_id, for every committed or in-flight turn retained.
        self._index: dict[UUID, UUID] = {}
        self._tombstones: OrderedDict[UUID, None] = OrderedDict()

    def clear(self) -> None:
        """Forget every conversation (the process is shutting down)."""
        with self._lock:
            self._entries.clear()
            self._tombstones.clear()

    def begin_turn(self, request: AgentTurnRequest) -> Cached | Accepted:
        with self._lock:
            now = self._clock()
            self._expire_idle(now)
            key = fingerprint(request)

            owner = self._index.get(request.client_turn_id)
            if owner is not None:
                if owner != request.conversation_id:
                    raise IdempotencyKeyReused
                owned = self._entries[owner]
                for turn in owned.committed:
                    if turn.client_turn_id == request.client_turn_id:
                        if turn.fingerprint != key:
                            raise IdempotencyKeyReused
                        owned.last_active = now
                        return Cached(turn.response)
                flight = owned.in_flight
                if flight is not None and flight.client_turn_id == request.client_turn_id:
                    if flight.fingerprint != key:
                        raise IdempotencyKeyReused
                    raise TurnInProgress

            if request.conversation_id in self._tombstones:
                raise ConversationExpired

            entry = self._entries.get(request.conversation_id)
            if entry is None:
                if request.turn_index != 1:
                    raise ConversationNotFound
                self._make_room()
                entry = _Entry(request.conversation_id, last_active=now)
                self._entries[request.conversation_id] = entry
            else:
                if entry.in_flight is not None:
                    raise ConversationBusy
                if len(entry.committed) >= self._max_turns:
                    raise ConversationLimitReached
                if request.turn_index != len(entry.committed) + 1:
                    raise TurnOutOfOrder

            token = self._token_factory()
            entry.in_flight = _InFlight(request.client_turn_id, key, token)
            entry.last_active = now
            self._index[request.client_turn_id] = entry.conversation_id
            return Accepted(
                conversation_id=entry.conversation_id,
                turn_token=token,
                snapshot=ConversationSnapshot(
                    history=entry.history,
                    offered=entry.offered,
                    pending_review=entry.pending_review,
                    committed_turns=len(entry.committed),
                ),
            )

    def commit_turn(
        self,
        conversation_id: UUID,
        turn_token: UUID,
        response: AgentTurnResponse,
        update: ConversationUpdate,
    ) -> bool:
        with self._lock:
            entry = self._entries.get(conversation_id)
            flight = entry.in_flight if entry is not None else None
            if entry is None or flight is None or flight.turn_token != turn_token:
                return False
            entry.committed.append(
                _CommittedTurn(flight.client_turn_id, flight.fingerprint, response)
            )
            entry.history = (entry.history + update.history_append)[-MAX_HISTORY_ENTRIES:]
            if update.offered is not None:
                entry.offered = update.offered
            if update.pending_review is not None:
                entry.pending_review = update.pending_review
            elif update.discarded_proposal is not None:
                entry.pending_review = None
            entry.in_flight = None
            entry.last_active = self._clock()
            return True

    def abort_turn(self, conversation_id: UUID, turn_token: UUID) -> bool:
        with self._lock:
            entry = self._entries.get(conversation_id)
            flight = entry.in_flight if entry is not None else None
            if entry is None or flight is None or flight.turn_token != turn_token:
                return False
            self._index.pop(flight.client_turn_id, None)
            entry.in_flight = None
            if not entry.committed:
                # Created by the failed request: remove it whole, without a tombstone, so an
                # identical first-turn retry creates it again.
                del self._entries[conversation_id]
            return True

    # -- everything below runs under the lock -------------------------------------------------

    def _expire_idle(self, now: datetime) -> None:
        expired = [
            entry
            for entry in self._entries.values()
            if entry.in_flight is None and now - entry.last_active > self._idle_ttl
        ]
        for entry in expired:
            self._remove(entry, tombstone=True)

    def _make_room(self) -> None:
        if len(self._entries) < self._max_conversations:
            return
        idle = [e for e in self._entries.values() if e.in_flight is None]
        if not idle:
            raise AgentBusy
        self._remove(min(idle, key=lambda e: e.last_active), tombstone=True)

    def _remove(self, entry: _Entry, *, tombstone: bool) -> None:
        """Delete the conversation with its cached responses, history, review summary and every
        index entry together."""
        for turn in entry.committed:
            self._index.pop(turn.client_turn_id, None)
        if entry.in_flight is not None:
            self._index.pop(entry.in_flight.client_turn_id, None)
        del self._entries[entry.conversation_id]
        if tombstone:
            self._tombstones[entry.conversation_id] = None
            while len(self._tombstones) > self._max_tombstones:
                self._tombstones.popitem(last=False)
