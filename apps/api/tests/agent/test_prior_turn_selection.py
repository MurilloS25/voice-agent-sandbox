"""A booking review may be prepared only for a slot offered in a previously committed turn.

The assistant shows available times first and the visitor chooses in a later message. Slots
returned by a search in the current turn may be shown but are not reviewable in it, and a turn
that did not complete (a system notice instead of the assistant's answer) promotes nothing.
"""

import contextlib
import re
import threading
from typing import Any
from uuid import uuid4

import pytest

from tests.agent.support import SLOT_DATE, AgentWorld, call_tools, kinds, say
from tests.agent.test_deadline import RefusingStore
from tests.agent.test_store import accept, complete, make_store, request, response_for
from tests.support import NOW
from voice_agent_api.agent.contracts import AgentTurnResponse
from voice_agent_api.agent.state import ConversationUpdate, OfferedSlot
from voice_agent_api.agent.store import InMemoryConversationStore

FIND = ("find_available_slots", {"service_id": "flat-repair", "date": SLOT_DATE})
FIND_EVENING = (
    "find_available_slots",
    {"service_id": "flat-repair", "date": SLOT_DATE, "earliest_local_time": "17:00"},
)
PREPARE = ("prepare_booking_review", {"slot_id": "S1"})
TOKEN = re.compile(r"v1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")
MORNING_START_Z = "2026-10-06T13:00:00Z"  # 09:00 in New York
EVENING_START_Z = "2026-10-06T21:00:00Z"  # 17:00 in New York


def results(response: AgentTurnResponse) -> list[tuple[str, str, str | None]]:
    return [(e.tool, e.status, e.code) for e in response.events if e.kind == "tool_result"]


def start_of(response: AgentTurnResponse) -> str:
    assert response.booking_review is not None
    return response.booking_review.start.strftime("%Y-%m-%dT%H:%M:%SZ")


def assert_nothing_proposed(response: AgentTurnResponse) -> None:
    assert response.booking_review is None
    assert "booking_review_ready" not in kinds(response)
    assert "proposal_token" not in response.model_dump_json()
    assert not TOKEN.search(response.model_dump_json())


# -- 1. a search and a selection never share a turn -----------------------------------------------


def test_find_then_prepare_in_the_same_turn_is_rejected_and_proposes_nothing() -> None:
    world = AgentWorld([call_tools(FIND), call_tools(PREPARE), say("Here are the times.")])
    response = world.send("What times do you have on Tuesday?")

    assert results(response) == [
        ("find_available_slots", "ok", None),
        ("prepare_booking_review", "rejected", "slot_not_offered"),
    ]
    assert_nothing_proposed(response)
    assert world.stored_bookings() == 0


def test_the_same_holds_when_both_calls_arrive_in_one_model_message() -> None:
    world = AgentWorld([call_tools(FIND, PREPARE), say("Here are the times.")])
    response = world.send("What times do you have on Tuesday?")

    assert results(response)[1] == ("prepare_booking_review", "rejected", "slot_not_offered")
    assert_nothing_proposed(response)


def test_the_rejection_tells_the_model_to_wait_and_leaks_no_token() -> None:
    world = AgentWorld([call_tools(FIND), call_tools(PREPARE), say("Here are the times.")])
    world.send("What times do you have on Tuesday?")

    last_call = world.model.calls[-1]
    tool_texts = [str(m.content) for m in last_call if m.type == "tool"]
    assert any("later message" in text for text in tool_texts)
    assert not any(TOKEN.search(text) for text in tool_texts)
    assert not any("proposal" in text.lower() for text in tool_texts)


def test_the_times_shown_in_that_turn_become_reviewable_in_the_next_one() -> None:
    world = AgentWorld(
        [
            call_tools(FIND),
            call_tools(PREPARE),
            say("Which one?"),
            call_tools(PREPARE),
            say("Review below."),
        ]
    )
    first = world.send("What times do you have on Tuesday?")
    assert_nothing_proposed(first)

    second = world.send("The first one please")  # an explicit selection, in a later message
    assert second.booking_review is not None
    assert start_of(second) == MORNING_START_Z


# -- 2. a selection in a later turn works ---------------------------------------------------------


def test_find_in_one_turn_and_an_explicit_selection_in_the_next_produces_a_review() -> None:
    world = AgentWorld([call_tools(FIND), say("Times."), call_tools(PREPARE), say("Review below.")])
    first = world.send("What times do you have?")
    assert_nothing_proposed(first)

    second = world.send("The first one")
    assert second.booking_review is not None
    assert kinds(second).count("booking_review_ready") == 1
    assert start_of(second) == MORNING_START_Z
    assert world.stored_bookings() == 0  # still only a proposal


def test_prepare_before_find_in_one_message_is_rejected() -> None:
    world = AgentWorld(
        [
            call_tools(FIND),
            say("Morning times."),
            call_tools(PREPARE, FIND_EVENING),
            say("Evening times."),
        ]
    )
    world.send("What times do you have?")
    response = world.send("What about the evening?")  # a search request, not a selection

    assert results(response) == [
        ("prepare_booking_review", "rejected", "slot_not_offered"),
        ("find_available_slots", "ok", None),
    ]
    assert_nothing_proposed(response)


def test_a_failed_search_does_not_free_the_assistant_to_choose_from_the_old_list() -> None:
    out_of_range = ("find_available_slots", {"service_id": "flat-repair", "date": "2030-01-01"})
    world = AgentWorld(
        [
            call_tools(FIND),
            say("Morning times."),
            call_tools(out_of_range),
            call_tools(PREPARE),
            say("That date is outside the window."),
        ]
    )
    world.send("What times do you have?")
    response = world.send("What about next year?")

    assert results(response) == [
        ("find_available_slots", "rejected", "date_out_of_range"),
        ("prepare_booking_review", "rejected", "slot_not_offered"),
    ]
    assert_nothing_proposed(response)


def test_an_unknown_service_search_does_not_free_the_assistant_either() -> None:
    unknown = ("find_available_slots", {"service_id": "gold-plating", "date": SLOT_DATE})
    world = AgentWorld(
        [call_tools(FIND), say("Times."), call_tools(unknown, PREPARE), say("No such service.")]
    )
    world.send("What times do you have?")
    response = world.send("What about gold plating?")
    assert results(response)[-1] == ("prepare_booking_review", "rejected", "slot_not_offered")
    assert_nothing_proposed(response)


def test_an_invalid_search_request_also_blocks_a_review_in_that_turn() -> None:
    bad = ("find_available_slots", {"service_id": "flat-repair", "date": "next tuesday"})
    world = AgentWorld(
        [call_tools(FIND), say("Times."), call_tools(bad, PREPARE), say("Which date?")]
    )
    world.send("What times do you have?")
    response = world.send("What about next Tuesday?")
    assert "guardrail" in kinds(response)  # the invalid search was refused
    assert results(response) == [("prepare_booking_review", "rejected", "slot_not_offered")]
    assert_nothing_proposed(response)


def test_a_turn_without_any_search_still_accepts_a_selection_from_the_prior_list() -> None:
    world = AgentWorld(
        [
            call_tools(FIND),
            say("Times."),
            say("Happy to help with something else too."),  # a turn with no search at all
            call_tools(PREPARE),
            say("Review below."),
        ]
    )
    world.send("What times do you have?")
    world.send("Thanks!")
    chosen = world.send("The first one")
    assert start_of(chosen) == MORNING_START_Z


# -- 3 and 4. refinements -------------------------------------------------------------------------


def test_a_refinement_cannot_be_selected_in_the_turn_that_produced_it() -> None:
    world = AgentWorld(
        [
            call_tools(FIND),
            say("Morning times."),
            call_tools(FIND_EVENING),
            call_tools(PREPARE),
            say("Evening times."),
        ]
    )
    world.send("What times do you have?")
    refined = world.send("Anything in the evening?")

    assert results(refined) == [
        ("find_available_slots", "ok", None),
        ("prepare_booking_review", "rejected", "slot_not_offered"),
    ]
    assert_nothing_proposed(refined)


def test_the_visitor_selects_from_the_refined_results_in_a_later_turn() -> None:
    world = AgentWorld(
        [
            call_tools(FIND),
            say("Morning times."),
            call_tools(FIND_EVENING),
            say("Evening times."),
            call_tools(PREPARE),
            say("Review below."),
        ]
    )
    world.send("What times do you have?")
    world.send("Anything in the evening?")
    chosen = world.send("The first one")

    assert start_of(chosen) == EVENING_START_Z  # the refined list's S1, not the earlier S1


# -- 5. older lists are replaced ------------------------------------------------------------------


def test_a_newer_committed_search_replaces_the_older_reviewable_slots() -> None:
    world = AgentWorld(
        [
            call_tools(FIND),
            say("Morning times."),
            call_tools(FIND_EVENING),
            say("Two evening times."),
            call_tools(("prepare_booking_review", {"slot_id": "S5"})),
            say("That is not on the list."),
        ]
    )
    world.send("What times do you have?")
    world.send("Anything in the evening?")
    stale = world.send("The fifth one")  # S5 existed in the first list only

    assert results(stale) == [("prepare_booking_review", "rejected", "slot_not_offered")]
    assert_nothing_proposed(stale)


# -- 6. turns that did not complete promote nothing -----------------------------------------------


def test_a_search_in_a_degraded_turn_does_not_replace_the_committed_list() -> None:
    world = AgentWorld(
        [
            call_tools(FIND),
            say("Morning times."),  # committed list A
            call_tools(FIND_EVENING),
            RuntimeError("provider down"),  # list B was never shown
            call_tools(PREPARE),
            say("Review below."),
        ]
    )
    world.send("What times do you have?")
    degraded = world.send("Anything in the evening?")
    assert degraded.outcome == "degraded"

    chosen = world.send("The first one")
    assert start_of(chosen) == MORNING_START_Z  # list A is still the reviewable one


def test_a_first_turn_that_degraded_after_a_search_offers_nothing_to_select() -> None:
    world = AgentWorld(
        [
            call_tools(FIND),
            RuntimeError("provider down"),
            call_tools(PREPARE),
            say("Not available."),
        ]
    )
    degraded = world.send("What times do you have?")
    assert degraded.outcome == "degraded"

    later = world.send("The first one")
    assert results(later) == [("prepare_booking_review", "rejected", "slot_not_offered")]
    assert_nothing_proposed(later)


def test_an_aborted_turn_promotes_nothing() -> None:
    store = RefusingStore(lambda: NOW)  # every commit is refused, like an aborted turn
    world = AgentWorld([call_tools(FIND), say("Times.")], store=store)
    with pytest.raises(Exception):  # noqa: B017 - AgentCommitFailed
        world.service.handle_turn(world.request("What times do you have?"))

    again = store.begin_turn(request(world.conversation_id, 1))
    assert again.snapshot.offered == ()  # type: ignore[union-attr]


# -- 7. retries keep the exact state --------------------------------------------------------------


def test_a_cached_retry_returns_the_same_bytes_and_does_not_disturb_the_reviewable_state() -> None:
    world = AgentWorld(
        [
            call_tools(FIND),
            say("Morning times."),
            call_tools(FIND_EVENING),
            say("Evening times."),
            call_tools(PREPARE),
            say("Review below."),
        ]
    )
    first_request = world.request("What times do you have?")
    first = world.service.handle_turn(first_request)
    world.turn_index = 1
    second = world.send("Anything in the evening?")

    replay = world.service.handle_turn(first_request)  # the old turn, retried after a newer one
    assert replay.model_dump_json() == first.model_dump_json()
    assert second.outcome == "completed"

    chosen = world.send("The first one")
    assert start_of(chosen) == EVENING_START_Z  # the newest committed list, not the replayed one
    assert len(world.model.calls) == 6  # the replay called nothing


# -- 8. atomic commit semantics -------------------------------------------------------------------


def slot(slot_id: str, service: str = "flat-repair") -> OfferedSlot:
    from datetime import UTC, datetime

    return OfferedSlot(
        slot_id=slot_id,
        service_id=service,
        service_name="Flat repair",
        start=datetime(2026, 10, 6, 13, 0, tzinfo=UTC),
        local_date="2026-10-06",
        weekday="Tuesday",
        local_start="09:00",
        local_end="09:30",
    )


def test_only_a_commit_changes_the_reviewable_set_and_a_snapshot_is_immutable() -> None:
    store, conversation = make_store(), uuid4()
    first = request(conversation, 1)
    accepted = accept(store, first)
    assert accepted.snapshot.offered == ()

    store.commit_turn(
        conversation,
        accepted.turn_token,
        response_for(first),
        ConversationUpdate(history_append=(), offered=(slot("S1"),)),
    )
    second = request(conversation, 2)
    next_turn = accept(store, second)
    assert [s.slot_id for s in next_turn.snapshot.offered] == ["S1"]
    assert accepted.snapshot.offered == ()  # the earlier snapshot did not change under it


def test_a_commit_without_an_offered_list_keeps_the_previous_one() -> None:
    store, conversation = make_store(), uuid4()
    first = request(conversation, 1)
    accepted = accept(store, first)
    store.commit_turn(
        conversation,
        accepted.turn_token,
        response_for(first),
        ConversationUpdate(history_append=(), offered=(slot("S1"),)),
    )
    complete(store, request(conversation, 2))  # a turn that offered nothing new
    assert [s.slot_id for s in accept(store, request(conversation, 3)).snapshot.offered] == ["S1"]


def test_a_stale_commit_cannot_promote_slots() -> None:
    store, conversation = make_store(), uuid4()
    first = request(conversation, 1)
    stale = accept(store, first)
    store.abort_turn(conversation, stale.turn_token)
    newer = accept(store, first)

    assert not store.commit_turn(
        conversation,
        stale.turn_token,
        response_for(first),
        ConversationUpdate(history_append=(), offered=(slot("S9"),)),
    )
    assert newer.snapshot.offered == ()
    store.abort_turn(conversation, newer.turn_token)
    assert accept(store, first).snapshot.offered == ()


def test_concurrent_turns_still_yield_one_acceptance_and_one_commit_of_slots() -> None:
    store, conversation = make_store(), uuid4()
    req = request(conversation, 1)
    accepted: list[Any] = []

    def attempt() -> None:
        with contextlib.suppress(Exception):  # the losers get TurnInProgress
            accepted.append(store.begin_turn(req))

    threads = [threading.Thread(target=attempt) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    winners = [a for a in accepted if hasattr(a, "turn_token")]
    assert len(winners) == 1
    assert store.commit_turn(
        conversation,
        winners[0].turn_token,
        response_for(req),
        ConversationUpdate(history_append=(), offered=(slot("S1"),)),
    )
    assert isinstance(store, InMemoryConversationStore)
    assert [s.slot_id for s in accept(store, request(conversation, 2)).snapshot.offered] == ["S1"]
