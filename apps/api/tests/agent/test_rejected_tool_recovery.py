"""Rejected tool results tell the model exactly how to recover, without echoing visitor text.

`service_not_found` points at `list_services`; `slot_unavailable` carries the fixed notice and the
committed service and date to search again. The recovered times stay non-reviewable until the
visitor chooses in a later message, and events stay on the approved timeline schema.
"""

import json
from datetime import UTC, date, datetime, time
from uuid import uuid4

from tests.agent.support import SLOT_DATE, AgentWorld, call_tools, kinds, say
from tests.agent.test_tools import executor, offered_slots, run
from tests.support import NOW, local_booking, make_world
from voice_agent_api.agent.contracts import AgentTurnResponse
from voice_agent_api.agent.prompts import build_system_prompt
from voice_agent_api.agent.state import OfferedSlot
from voice_agent_api.agent.tools import ToolOutcome, read_prompt_facts
from voice_agent_api.domain.commands import confirm_appointment, propose_appointment

FIND = ("find_available_slots", {"service_id": "flat-repair", "date": SLOT_DATE})
PREPARE = ("prepare_booking_review", {"slot_id": "S1"})
INVALID = "gold-plating-xyz-7731"
FIRST_START = datetime(2026, 10, 6, 13, 0, tzinfo=UTC)


def prompt() -> str:
    catalog, _ = make_world()
    return build_system_prompt(read_prompt_facts(catalog, NOW), NOW, (), None)


def take_first_slot(world: AgentWorld) -> None:
    """Other customers take every bench for the first offered time (domain commands only)."""
    while True:
        try:
            review = propose_appointment(world.book, "flat-repair", FIRST_START, NOW, uuid4)
        except Exception:
            return
        confirm_appointment(world.book, review.proposal, NOW, source="test_other_customer")


def results(response: AgentTurnResponse) -> list[tuple[str, str, str | None]]:
    return [(e.tool, e.status, e.code) for e in response.events if e.kind == "tool_result"]


# -- service_not_found ----------------------------------------------------------------------------


def test_service_not_found_gives_fixed_guidance_and_the_next_action() -> None:
    tools, _ = executor()
    outcome = run(tools, "find_available_slots", {"service_id": INVALID, "date": SLOT_DATE})
    data = json.loads(outcome.content)

    assert (outcome.status, outcome.code) == ("rejected", "service_not_found")
    assert data == {
        "status": "rejected",
        "code": "service_not_found",
        "message": "The requested service is not offered.",
        "next_action": "list_services",
    }


def test_service_not_found_does_not_echo_the_submitted_service_or_embed_the_catalog() -> None:
    tools, _ = executor()
    outcome = run(tools, "find_available_slots", {"service_id": INVALID, "date": SLOT_DATE})
    everything = outcome.content + outcome.summary
    assert INVALID not in everything
    assert "flat-repair" not in everything and "Flat repair" not in everything
    assert "USD" not in everything


def test_service_not_found_makes_no_slots_offered() -> None:
    tools, _ = executor()
    assert (
        run(tools, "find_available_slots", {"service_id": INVALID, "date": SLOT_DATE}).offered
        is None
    )


# -- slot_unavailable -----------------------------------------------------------------------------


def taken_outcome() -> ToolOutcome:
    day = date(2026, 10, 6)
    tools, _ = executor()
    offered = offered_slots(tools)
    full = [
        local_booking("flat-repair", day, offered_time(offered[0]), 30, bench=b) for b in (1, 2)
    ]
    taken_tools, _ = executor(full)
    return run(taken_tools, "prepare_booking_review", {"slot_id": "S1"}, offered)


def offered_time(slot: OfferedSlot) -> time:
    hour, minute = (int(part) for part in slot.local_start.split(":"))
    return time(hour, minute)


def test_slot_unavailable_has_the_fixed_notice_the_next_action_and_the_committed_search() -> None:
    outcome = taken_outcome()
    data = json.loads(outcome.content)

    assert (outcome.status, outcome.code) == ("rejected", "slot_unavailable")
    assert data["required_notice"] == "That time is no longer available."
    assert data["next_action"] == "find_available_slots"
    assert data["search"] == {"service_id": "flat-repair", "date": SLOT_DATE}
    assert outcome.review is None and outcome.offered is None


def test_slot_unavailable_leaks_no_token_or_identifier() -> None:
    content = taken_outcome().content
    assert "v1." not in content and "proposal" not in content.lower()


# -- the prompt -----------------------------------------------------------------------------------


def test_the_prompt_requires_list_services_for_an_unknown_service() -> None:
    text = prompt()
    assert "call list_services" in text and "not offered" in text
    assert "list the real services" in text
    assert "search only after the visitor picks one" in text
    assert "not in the list below" in text  # also when the model sees it needs no search


def test_the_prompt_requires_acknowledging_and_refreshing_after_slot_unavailable() -> None:
    text = prompt()
    assert "no longer available" in text and "tell the visitor" in text
    assert "call find_available_slots with the result's service_id and date" in text
    assert "(none: ask)" in text
    assert "offer only new times" in text
    assert "prepare nothing that message" in text


def test_the_prompt_makes_rejected_results_authoritative_and_hides_internal_codes() -> None:
    text = prompt()
    assert "Rejected tool results are authoritative" in text
    assert "follow their next_action" in text
    assert "never show internal codes" in text


# -- end to end, offline --------------------------------------------------------------------------


def test_recovery_after_a_taken_slot_refreshes_alternatives_without_a_same_turn_review() -> None:
    world = AgentWorld(
        [
            call_tools(FIND),
            say("Times."),
            call_tools(PREPARE),
            call_tools(FIND),
            call_tools(PREPARE),
            say("That time is no longer available; try these."),
            call_tools(PREPARE),
            say("Review below."),
        ]
    )
    world.send("What times do you have?")
    take_first_slot(world)
    others = world.stored_bookings()
    recovery = world.send("The first one")

    assert results(recovery) == [
        ("prepare_booking_review", "rejected", "slot_unavailable"),
        ("find_available_slots", "ok", None),
        ("prepare_booking_review", "rejected", "slot_not_offered"),  # no same-turn review
    ]
    assert recovery.booking_review is None
    assert "booking_review_ready" not in kinds(recovery)

    chosen = world.send("The first one of those")  # alternatives are reviewable only now
    assert chosen.booking_review is not None
    assert (
        world.stored_bookings() == others
    )  # only the other customers' bookings, never the agent's


def test_the_model_sees_the_fixed_notice_and_the_search_to_repeat() -> None:
    world = AgentWorld([call_tools(FIND), say("Times."), call_tools(PREPARE), say("Taken.")])
    world.send("What times do you have?")
    take_first_slot(world)
    world.send("The first one")

    tool_texts = [str(m.content) for m in world.model.calls[-1] if m.type == "tool"]
    assert any("That time is no longer available." in t for t in tool_texts)
    assert any('"next_action":"find_available_slots"' in t for t in tool_texts)
    assert any('"service_id":"flat-repair"' in t and SLOT_DATE in t for t in tool_texts)


def test_service_not_found_end_to_end_does_not_echo_the_invalid_service_to_the_model() -> None:
    bad = ("find_available_slots", {"service_id": INVALID, "date": SLOT_DATE})
    world = AgentWorld([call_tools(bad), call_tools(("list_services", {})), say("Not offered.")])
    response = world.send("Do you do gold plating?")

    assert results(response) == [
        ("find_available_slots", "rejected", "service_not_found"),
        ("list_services", "ok", None),
    ]
    model_tool_texts = [str(m.content) for m in world.model.calls[-1] if m.type == "tool"]
    assert not any(INVALID in t for t in model_tool_texts)
    assert any('"next_action":"list_services"' in t for t in model_tool_texts)
    assert response.booking_review is None


# -- events stay on the approved schema -----------------------------------------------------------


def test_events_carry_only_the_code_and_a_fixed_summary_not_the_next_action() -> None:
    bad = ("find_available_slots", {"service_id": INVALID, "date": SLOT_DATE})
    world = AgentWorld([call_tools(bad), say("Not offered.")])
    response = world.send("Do you do gold plating?")

    raw = response.model_dump_json()
    assert "next_action" not in raw and "required_notice" not in raw
    event = next(e for e in response.events if e.kind == "tool_result")
    assert event.code == "service_not_found" and event.summary == "That service is not offered."
    assert set(event.model_dump()) >= {"tool", "status", "code", "summary"}


def test_without_a_committed_slot_the_result_has_no_search_so_the_model_must_ask() -> None:
    from voice_agent_api.agent.tools import _slot_unavailable

    data = json.loads(_slot_unavailable().content)
    assert "search" not in data
    assert data["required_notice"] == "That time is no longer available."
