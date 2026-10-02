"""Bounded waits, the turn deadline, late results, commit failure and the in-flight cap."""

import threading
import time
from uuid import UUID

import pytest
from langchain_core.messages import AIMessage, BaseMessage, SystemMessage

from tests.agent.support import (
    SLOT_DATE,
    AgentWorld,
    GateBook,
    blocked_until,
    call_tools,
    say,
)
from tests.support import NOW
from voice_agent_api.agent.bounded import BoundedCaller, CallTimedOut, Deadline, DeadlineExceeded
from voice_agent_api.agent.contracts import AgentTurnRequest, AgentTurnResponse
from voice_agent_api.agent.errors import AgentBusy
from voice_agent_api.agent.limits import AgentLimits
from voice_agent_api.agent.orchestrator import AgentCommitFailed
from voice_agent_api.agent.state import ConversationUpdate
from voice_agent_api.agent.store import InMemoryConversationStore

FIND = ("find_available_slots", {"service_id": "flat-repair", "date": SLOT_DATE})
PREPARE = ("prepare_booking_review", {"slot_id": "S1"})
MIN_START = 0.05


def wait_until(condition: object, timeout: float = 3.0) -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if condition():  # type: ignore[operator]
            return
        time.sleep(0.01)
    raise AssertionError("condition not reached")


# -- BoundedCaller -----------------------------------------------------------------------------


def test_a_call_returns_its_value_and_propagates_its_exception() -> None:
    caller = BoundedCaller(2)
    deadline = Deadline.after(5)
    assert caller.call(lambda: 7, limit_s=1, deadline=deadline, min_start_s=0) == 7

    def boom() -> int:
        raise TimeoutError("its own timeout, not ours")

    with pytest.raises(TimeoutError):
        caller.call(boom, limit_s=1, deadline=deadline, min_start_s=0)
    caller.close()


def test_a_call_that_outlasts_its_limit_times_out_without_being_cancelled() -> None:
    caller, release = BoundedCaller(2), threading.Event()
    started = time.monotonic()
    with pytest.raises(CallTimedOut):
        caller.call(
            lambda: release.wait(5), limit_s=0.1, deadline=Deadline.after(10), min_start_s=0
        )
    assert time.monotonic() - started < 1
    release.set()
    caller.close()


def test_a_deadline_shorter_than_the_limit_ends_the_wait_as_deadline_exceeded() -> None:
    caller, release = BoundedCaller(2), threading.Event()
    started = time.monotonic()
    with pytest.raises(DeadlineExceeded):
        caller.call(
            lambda: release.wait(5), limit_s=5, deadline=Deadline.after(0.15), min_start_s=0
        )
    assert time.monotonic() - started < 1
    release.set()
    caller.close()


def test_no_call_starts_with_less_than_the_minimum_time_left() -> None:
    caller, ran = BoundedCaller(2), []
    deadline = Deadline(expires_at=10.0, clock=lambda: 9.5)
    with pytest.raises(DeadlineExceeded):
        caller.call(lambda: ran.append(1), limit_s=5, deadline=deadline, min_start_s=1.0)
    assert ran == []
    caller.close()


# -- the turn deadline -------------------------------------------------------------------------


def test_a_blocked_model_call_ends_at_the_deadline_and_a_late_result_changes_nothing() -> None:
    release = threading.Event()
    limits = AgentLimits(
        turn_deadline_s=0.4, model_timeout_s=5, tool_timeout_s=5, min_call_start_s=MIN_START
    )
    finished = threading.Event()
    world = AgentWorld([blocked_until(release, say("TOO-LATE-ANSWER"), finished)], limits=limits)
    request = world.request("hello")

    started = time.monotonic()
    first = world.service.handle_turn(request)
    assert time.monotonic() - started < 0.4 + 2.0  # generous: slow CI must not flake
    assert first.outcome == "degraded"
    assert any(e.kind == "turn_error" and e.code == "turn_deadline_exceeded" for e in first.events)

    before = first.model_dump_json()
    release.set()
    assert finished.wait(5)  # the abandoned call really did finish and hand back its answer
    replay = world.service.handle_turn(request)
    assert replay.model_dump_json() == before
    assert "TOO-LATE-ANSWER" not in before
    assert len(world.model.calls) == 1

    # The conversation is intact and usable.
    world.turn_index = 1
    world.model.add_steps(say("hello again"))
    assert world.send("still there?").outcome == "completed"


def test_a_slow_model_call_hits_its_own_limit_before_the_deadline() -> None:
    release = threading.Event()
    limits = AgentLimits(
        turn_deadline_s=5, model_timeout_s=0.1, tool_timeout_s=5, min_call_start_s=MIN_START
    )
    world = AgentWorld([blocked_until(release, say("late"))], limits=limits)

    started = time.monotonic()
    response = world.send("hello")
    assert time.monotonic() - started < 1
    assert any(e.kind == "provider_error" and e.code == "model_timeout" for e in response.events)
    release.set()


def test_nothing_starts_when_too_little_time_is_left() -> None:
    limits = AgentLimits(turn_deadline_s=0.3, min_call_start_s=5.0)
    world = AgentWorld([say("never")], limits=limits)
    response = world.send("hello")

    assert response.outcome == "degraded"
    assert any(
        e.kind == "turn_error" and e.code == "turn_deadline_exceeded" for e in response.events
    )
    assert world.model.calls == []


def test_a_slow_tool_times_out_and_the_turn_continues() -> None:
    limits = AgentLimits(
        turn_deadline_s=5, model_timeout_s=5, tool_timeout_s=0.1, min_call_start_s=MIN_START
    )
    world = AgentWorld(
        [call_tools(FIND), say("The schedule is slow right now.")],
        limits=limits,
        wrap_book=GateBook,
    )
    assert isinstance(world.wrapped_book, GateBook)
    world.wrapped_book.block = True
    response = world.send("times")

    result = next(e for e in response.events if e.kind == "tool_result")
    assert (result.status, result.code) == ("error", "tool_timeout")
    assert response.outcome == "completed"
    world.wrapped_book.release.set()


def test_an_abandoned_review_is_discarded_entirely() -> None:
    limits = AgentLimits(
        turn_deadline_s=5, model_timeout_s=5, tool_timeout_s=0.15, min_call_start_s=MIN_START
    )
    world = AgentWorld([], limits=limits, wrap_book=GateBook)
    gate = world.wrapped_book
    assert isinstance(gate, GateBook)

    def block_then_prepare(_: list[BaseMessage]) -> AIMessage:
        gate.block = True
        return call_tools(PREPARE)

    world.model.add_steps(
        call_tools(FIND), say("times"), block_then_prepare, say("slow"), say("hi")
    )
    world.send("times")
    second = world.send("first")

    result = next(e for e in second.events if e.kind == "tool_result")
    assert result.code == "tool_timeout"
    assert second.booking_review is None
    assert not any(e.kind == "booking_review_ready" for e in second.events)

    gate.release.set()  # the abandoned propose finishes and is ignored
    assert gate.finished.wait(5)
    world.send("anything")
    system = world.model.calls[-1][0]
    assert isinstance(system, SystemMessage)
    assert "waiting for the visitor" not in str(system.content)
    assert world.stored_bookings() == 0


# -- commit failure and the in-flight cap ------------------------------------------------------


class RefusingStore(InMemoryConversationStore):
    def commit_turn(
        self,
        conversation_id: UUID,
        turn_token: UUID,
        response: AgentTurnResponse,
        update: ConversationUpdate,
    ) -> bool:
        return False


def test_a_refused_commit_releases_the_marker_so_an_identical_retry_runs() -> None:
    world = AgentWorld([say("one"), say("two")], store=RefusingStore(lambda: NOW))
    request = world.request("hello")

    with pytest.raises(AgentCommitFailed):
        world.service.handle_turn(request)
    with pytest.raises(AgentCommitFailed):  # accepted again, not "in progress", not leaked
        world.service.handle_turn(request)
    assert len(world.model.calls) == 2


def test_a_failing_commit_also_releases_the_marker() -> None:
    class Exploding(InMemoryConversationStore):
        def commit_turn(self, *args: object, **kwargs: object) -> bool:
            raise RuntimeError("store bug")

    world = AgentWorld([say("one"), say("two")], store=Exploding(lambda: NOW))
    request = world.request("hello")
    with pytest.raises(RuntimeError):
        world.service.handle_turn(request)
    with pytest.raises(RuntimeError):
        world.service.handle_turn(request)  # accepted again: the marker did not leak


def test_the_global_in_flight_cap_refuses_extra_turns_and_releases_what_it_created() -> None:
    release = threading.Event()
    limits = AgentLimits(max_in_flight_turns=1, min_call_start_s=MIN_START)
    world = AgentWorld([blocked_until(release, say("first"))], limits=limits)

    first_result: list[AgentTurnResponse] = []
    worker = threading.Thread(target=lambda: first_result.append(world.send("one")))
    worker.start()
    wait_until(lambda: len(world.model.calls) == 1)

    other = AgentTurnRequest(
        conversation_id=UUID(int=99), client_turn_id=UUID(int=100), turn_index=1, message="hi"
    )
    with pytest.raises(AgentBusy):
        world.service.handle_turn(other)

    release.set()
    worker.join(5)
    assert first_result and first_result[0].outcome == "completed"

    world.model.add_steps(say("now free"))
    assert world.service.handle_turn(other).outcome == "completed"  # the marker was released
