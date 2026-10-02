"""The in-memory conversation store: process-scoped idempotency, expiry, eviction and abort."""

import threading
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest

from tests.support import NOW
from voice_agent_api.agent.contracts import AgentReply, AgentTurnRequest, AgentTurnResponse
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
from voice_agent_api.agent.state import ConversationUpdate, HistoryEntry
from voice_agent_api.agent.store import Accepted, Cached, InMemoryConversationStore


class ManualClock:
    def __init__(self) -> None:
        self.now = NOW

    def __call__(self) -> datetime:
        return self.now

    def advance(self, delta: timedelta) -> None:
        self.now += delta


def request(
    conversation: UUID, index: int, *, message: str = "hi", turn: UUID | None = None
) -> AgentTurnRequest:
    return AgentTurnRequest(
        conversation_id=conversation,
        client_turn_id=turn or uuid4(),
        turn_index=index,
        message=message,
    )


def response_for(req: AgentTurnRequest, text: str = "ok") -> AgentTurnResponse:
    return AgentTurnResponse(
        conversation_id=req.conversation_id,
        client_turn_id=req.client_turn_id,
        turn_index=req.turn_index,
        outcome="completed",
        reply=AgentReply(source="assistant", text=text),
        events=[],
        booking_review=None,
    )


def accept(store: InMemoryConversationStore, req: AgentTurnRequest) -> Accepted:
    decision = store.begin_turn(req)
    assert isinstance(decision, Accepted)
    return decision


def complete(
    store: InMemoryConversationStore, req: AgentTurnRequest, text: str = "ok"
) -> AgentTurnResponse:
    accepted = accept(store, req)
    response = response_for(req, text)
    update = ConversationUpdate(history_append=(HistoryEntry("user", req.message),))
    assert store.commit_turn(accepted.conversation_id, accepted.turn_token, response, update)
    return response


def make_store(clock: ManualClock | None = None, **kwargs: Any) -> InMemoryConversationStore:
    return InMemoryConversationStore(clock or ManualClock(), **kwargs)


# -- idempotency rules -------------------------------------------------------------------------


def test_a_committed_turn_is_replayed_exactly() -> None:
    store, conv = make_store(), uuid4()
    req = request(conv, 1)
    original = complete(store, req)

    replay = store.begin_turn(req)
    assert isinstance(replay, Cached)
    assert replay.response is original


def test_a_first_turn_retry_while_in_flight_is_turn_in_progress_then_cached() -> None:
    store, conv = make_store(), uuid4()
    req = request(conv, 1)
    accepted = accept(store, req)

    with pytest.raises(TurnInProgress):
        store.begin_turn(req)
    response = response_for(req)
    store.commit_turn(conv, accepted.turn_token, response, ConversationUpdate(history_append=()))
    assert isinstance(store.begin_turn(req), Cached)


def test_an_earlier_turn_is_still_replayed_after_later_turns() -> None:
    store, conv = make_store(), uuid4()
    first, second, third = request(conv, 1), request(conv, 2), request(conv, 3)
    original = complete(store, first, "first")
    complete(store, second)
    complete(store, third)

    replay = store.begin_turn(first)
    assert isinstance(replay, Cached) and replay.response is original


def test_the_same_key_with_a_different_message_is_never_a_retry() -> None:
    store, conv = make_store(), uuid4()
    turn = uuid4()
    complete(store, request(conv, 1, message="one", turn=turn))

    with pytest.raises(IdempotencyKeyReused):
        store.begin_turn(request(conv, 1, message="two", turn=turn))


def test_the_same_key_with_a_different_message_while_in_flight_is_refused_too() -> None:
    store, conv, turn = make_store(), uuid4(), uuid4()
    accept(store, request(conv, 1, message="one", turn=turn))
    with pytest.raises(IdempotencyKeyReused):
        store.begin_turn(request(conv, 1, message="two", turn=turn))


def test_the_same_key_in_another_conversation_is_refused() -> None:
    store, turn = make_store(), uuid4()
    complete(store, request(uuid4(), 1, turn=turn))
    with pytest.raises(IdempotencyKeyReused):
        store.begin_turn(request(uuid4(), 1, turn=turn))


def test_the_same_key_with_a_different_turn_index_is_refused() -> None:
    store, conv, turn = make_store(), uuid4(), uuid4()
    complete(store, request(conv, 1, turn=turn))
    with pytest.raises(IdempotencyKeyReused):
        store.begin_turn(request(conv, 2, turn=turn))


def test_an_unknown_conversation_is_not_found_after_the_first_turn_and_created_on_it() -> None:
    store = make_store()
    with pytest.raises(ConversationNotFound):
        store.begin_turn(request(uuid4(), 2))
    assert isinstance(store.begin_turn(request(uuid4(), 1)), Accepted)


def test_a_different_turn_while_one_is_in_flight_is_busy_and_consumes_nothing() -> None:
    store, conv = make_store(), uuid4()
    first = request(conv, 1)
    accepted = accept(store, first)
    with pytest.raises(ConversationBusy):
        store.begin_turn(request(conv, 2))

    store.commit_turn(
        conv, accepted.turn_token, response_for(first), ConversationUpdate(history_append=())
    )
    assert isinstance(store.begin_turn(request(conv, 2)), Accepted)


def test_turns_must_arrive_in_order() -> None:
    store, conv = make_store(), uuid4()
    complete(store, request(conv, 1))
    with pytest.raises(TurnOutOfOrder):
        store.begin_turn(request(conv, 3))
    with pytest.raises(TurnOutOfOrder):
        store.begin_turn(request(conv, 1))  # a new key for an index already used


def test_the_turn_limit_is_enforced() -> None:
    store, conv = make_store(max_turns=2), uuid4()
    complete(store, request(conv, 1))
    complete(store, request(conv, 2))
    with pytest.raises(ConversationLimitReached):
        store.begin_turn(request(conv, 3))


# -- expiry, tombstones and restart ------------------------------------------------------------


def test_an_idle_conversation_expires_to_410_even_for_a_retry() -> None:
    clock = ManualClock()
    store, conv = make_store(clock), uuid4()
    first = request(conv, 1)
    complete(store, first)

    clock.advance(timedelta(minutes=31))
    with pytest.raises(ConversationExpired):
        store.begin_turn(request(conv, 2))
    with pytest.raises(ConversationExpired):
        store.begin_turn(first)  # the cache went with the conversation


def test_activity_refreshes_the_idle_timer() -> None:
    clock = ManualClock()
    store, conv = make_store(clock), uuid4()
    complete(store, request(conv, 1))
    clock.advance(timedelta(minutes=20))
    complete(store, request(conv, 2))
    clock.advance(timedelta(minutes=20))
    assert isinstance(store.begin_turn(request(conv, 3)), Accepted)


def test_a_fresh_store_after_a_restart_forgets_everything() -> None:
    old, conv = make_store(), uuid4()
    first = request(conv, 1)
    complete(old, first)
    complete(old, request(conv, 2))

    restarted = make_store()
    # Later turns: not found.
    with pytest.raises(ConversationNotFound):
        restarted.begin_turn(request(conv, 3))
    # A first turn is indistinguishable from a new conversation: it is accepted again (the
    # model may run again), it is NOT recognised as the pre-restart retry.
    assert isinstance(restarted.begin_turn(first), Accepted)


def test_a_tombstone_that_left_the_fifo_behaves_like_a_fresh_store() -> None:
    clock = ManualClock()
    store = make_store(clock, max_tombstones=2)
    conversations = [uuid4() for _ in range(3)]
    firsts = [request(c, 1) for c in conversations]
    for first in firsts:
        complete(store, first)
    clock.advance(timedelta(minutes=31))
    store.begin_turn(request(uuid4(), 1))  # triggers cleanup: three tombstones, FIFO keeps two

    with pytest.raises(ConversationExpired):
        store.begin_turn(request(conversations[2], 2))
    # The oldest tombstone is gone: later turns are 404 and a first turn creates it anew.
    with pytest.raises(ConversationNotFound):
        store.begin_turn(request(conversations[0], 2))
    assert isinstance(store.begin_turn(request(conversations[0], 1)), Accepted)


# -- capacity and eviction ---------------------------------------------------------------------


def test_eviction_removes_the_least_recently_active_idle_conversation_and_its_index() -> None:
    clock = ManualClock()
    store = make_store(clock, max_conversations=2)
    a, b, c = uuid4(), uuid4(), uuid4()
    a_first = request(a, 1)
    complete(store, a_first)
    clock.advance(timedelta(minutes=1))
    complete(store, request(b, 1))
    clock.advance(timedelta(minutes=1))

    accept(store, request(c, 1))  # at capacity: evicts `a`
    with pytest.raises(ConversationExpired):
        store.begin_turn(request(a, 2))
    # a's index entries were removed with it, so its old key is free to use elsewhere.
    assert isinstance(store.begin_turn(request(uuid4(), 1, turn=a_first.client_turn_id)), Accepted)


def test_eviction_skips_conversations_with_a_turn_in_flight() -> None:
    clock = ManualClock()
    store = make_store(clock, max_conversations=2)
    busy, idle, new = uuid4(), uuid4(), uuid4()
    accept(store, request(busy, 1))  # in flight, and the oldest
    clock.advance(timedelta(minutes=1))
    complete(store, request(idle, 1))
    clock.advance(timedelta(minutes=1))

    accept(store, request(new, 1))
    with pytest.raises(ConversationBusy):  # `busy` survived
        store.begin_turn(request(busy, 2))
    with pytest.raises(ConversationExpired):  # `idle` was evicted
        store.begin_turn(request(idle, 2))


def test_when_every_conversation_is_in_flight_a_new_one_is_agent_busy() -> None:
    store = make_store(max_conversations=2)
    accept(store, request(uuid4(), 1))
    accept(store, request(uuid4(), 1))
    with pytest.raises(AgentBusy):
        store.begin_turn(request(uuid4(), 1))


# -- commit and abort --------------------------------------------------------------------------


def test_a_commit_with_a_stale_token_changes_nothing() -> None:
    store, conv = make_store(), uuid4()
    req = request(conv, 1)
    accept(store, req)
    assert not store.commit_turn(
        conv, uuid4(), response_for(req), ConversationUpdate(history_append=())
    )
    with pytest.raises(TurnInProgress):  # still in flight
        store.begin_turn(req)


def test_history_is_bounded() -> None:
    store, conv = make_store(), uuid4()
    for index in range(1, 21):  # one history entry per turn here
        complete(store, request(conv, index, message=f"message {index}"))
    accepted = accept(store, request(conv, 21))
    assert len(accepted.snapshot.history) == 16
    assert accepted.snapshot.history[0].text == "message 5"
    assert accepted.snapshot.history[-1].text == "message 20"


def test_abort_of_a_follow_up_turn_frees_the_key_and_keeps_the_conversation() -> None:
    store, conv = make_store(), uuid4()
    first = request(conv, 1)
    complete(store, first)
    second = request(conv, 2)
    accepted = accept(store, second)

    assert store.abort_turn(conv, accepted.turn_token)
    assert isinstance(store.begin_turn(second), Accepted)  # identical retry is accepted anew
    assert isinstance(store.begin_turn(first), Cached)  # committed turn untouched


def test_abort_of_a_created_conversation_removes_it_without_a_tombstone() -> None:
    store, conv = make_store(), uuid4()
    first = request(conv, 1)
    accepted = accept(store, first)

    assert store.abort_turn(conv, accepted.turn_token)
    assert isinstance(store.begin_turn(first), Accepted)  # not 410, not "in progress"


def test_a_stale_abort_cannot_clear_a_newer_turn() -> None:
    store, conv = make_store(), uuid4()
    first = request(conv, 1)
    stale = accept(store, first)
    assert store.abort_turn(conv, stale.turn_token)
    newer = accept(store, first)

    assert not store.abort_turn(conv, stale.turn_token)
    with pytest.raises(TurnInProgress):
        store.begin_turn(first)
    assert store.abort_turn(conv, newer.turn_token)


def test_a_commit_after_an_abort_is_refused() -> None:
    store, conv = make_store(), uuid4()
    req = request(conv, 1)
    accepted = accept(store, req)
    store.abort_turn(conv, accepted.turn_token)
    assert not store.commit_turn(
        conv, accepted.turn_token, response_for(req), ConversationUpdate(history_append=())
    )


# -- races -------------------------------------------------------------------------------------


def run_parallel(count: int, work: object) -> list[object]:
    results: list[object] = []
    lock = threading.Lock()
    barrier = threading.Barrier(count)

    def worker(index: int) -> None:
        barrier.wait()
        try:
            outcome: object = work(index)  # type: ignore[operator]
        except Exception as exc:
            outcome = exc
        with lock:
            results.append(outcome)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results


def test_many_threads_with_the_same_key_yield_exactly_one_acceptance() -> None:
    store, req = make_store(), request(uuid4(), 1)
    results = run_parallel(16, lambda _: store.begin_turn(req))

    assert sum(isinstance(r, Accepted) for r in results) == 1
    assert sum(isinstance(r, TurnInProgress) for r in results) == 15


def test_two_different_turns_for_one_conversation_yield_one_acceptance_and_one_busy() -> None:
    store, conv = make_store(), uuid4()
    complete(store, request(conv, 1))
    reqs = [request(conv, 2), request(conv, 2)]
    results = run_parallel(2, lambda i: store.begin_turn(reqs[i]))

    assert sum(isinstance(r, Accepted) for r in results) == 1
    assert sum(isinstance(r, ConversationBusy) for r in results) == 1
