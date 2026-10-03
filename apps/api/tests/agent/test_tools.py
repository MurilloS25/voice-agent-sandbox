"""The allow-listed tools against the real domain, with a fixed clock."""

import json
from datetime import date, time
from typing import Any
from uuid import UUID

import pytest
from pydantic import ValidationError

from tests.agent.support import KEY, SLOT_DATE
from tests.support import FLAT_REPAIR, NOW, SLOT_START, id_sequence, local_booking, make_world
from voice_agent_api.agent.errors import AgentWriteForbidden
from voice_agent_api.agent.limits import AgentLimits
from voice_agent_api.agent.readonly import ReadOnlyAppointmentBook
from voice_agent_api.agent.tools import (
    TOOLS,
    ToolExecutor,
    ToolOutcome,
    parse_tool_args,
    tool_input_for_event,
    tool_specs,
)
from voice_agent_api.api.proposal_tokens import ProposalTokenCodec
from voice_agent_api.domain.models import Booking


def executor(bookings: list[Booking] | None = None) -> tuple[ToolExecutor, Any]:
    catalog, book = make_world(bookings or [])
    codec = ProposalTokenCodec(KEY)
    return (
        ToolExecutor(
            catalog, ReadOnlyAppointmentBook(book), id_sequence(), codec.encode, AgentLimits()
        ),
        book,
    )


def run(
    tools: ToolExecutor, name: str, raw: dict[str, Any], offered: tuple[Any, ...] = ()
) -> ToolOutcome:
    return tools.run(name, parse_tool_args(name, raw), offered, NOW)


def test_the_allow_list_is_exactly_the_five_tools() -> None:
    assert list(TOOLS) == [
        "get_business_info",
        "list_services",
        "find_available_slots",
        "prepare_booking_review",
        "discard_booking_review",
    ]
    assert [s["function"]["name"] for s in tool_specs()] == list(TOOLS)


def test_business_info_has_hours_and_window_but_no_internal_ids() -> None:
    tools, _ = executor()
    outcome = run(tools, "get_business_info", {})
    data = json.loads(outcome.content)

    assert outcome.status == "ok"
    assert data["timezone"] == "America/New_York"
    assert {"day": "Tuesday", "open": "09:00", "close": "13:00"} in data["hours"]
    assert data["booking_window"] == {"first_date": "2026-09-30", "last_date": "2026-10-14"}
    assert "id" not in data


def test_services_list_shows_price_and_duration() -> None:
    tools, _ = executor()
    data = json.loads(run(tools, "list_services", {}).content)
    flat = next(s for s in data["services"] if s["id"] == "flat-repair")
    assert (flat["minutes"], flat["price"]) == (30, "15.00 USD")


def test_slots_get_sequential_ids_local_times_and_a_cap_of_ten() -> None:
    tools, _ = executor()
    outcome = run(tools, "find_available_slots", {"service_id": "flat-repair", "date": SLOT_DATE})

    assert outcome.offered is not None
    assert [s.slot_id for s in outcome.offered] == [f"S{n}" for n in range(1, 11)]
    assert outcome.offered[0].local_start == "09:00"
    assert json.loads(outcome.content)["more_available"] is True
    assert outcome.offered[0].start == SLOT_START.replace(hour=13)  # 09:00 EDT is 13:00 UTC


def test_the_local_time_filters_apply() -> None:
    tools, _ = executor()
    outcome = run(
        tools,
        "find_available_slots",
        {
            "service_id": "flat-repair",
            "date": SLOT_DATE,
            "earliest_local_time": "14:00",
            "latest_local_time": "15:00",
        },
    )
    assert outcome.offered is not None
    assert [s.local_start for s in outcome.offered] == ["14:00", "14:30", "15:00"]


def test_several_days_are_searched_and_a_later_day_past_the_window_just_ends_the_search() -> None:
    tools, _ = executor()
    outcome = run(
        tools,
        "find_available_slots",
        {
            "service_id": "flat-repair",
            "date": "2026-10-13",
            "days": 3,
            "earliest_local_time": "17:00",
        },
    )
    assert outcome.status == "ok" and outcome.offered is not None
    assert {s.local_date for s in outcome.offered} == {"2026-10-13", "2026-10-14"}


def test_a_first_day_outside_the_window_is_rejected_with_the_window() -> None:
    tools, _ = executor()
    outcome = run(
        tools, "find_available_slots", {"service_id": "flat-repair", "date": "2026-10-20"}
    )
    assert (outcome.status, outcome.code) == ("rejected", "date_out_of_range")
    assert json.loads(outcome.content)["last_date"] == "2026-10-14"


def test_unknown_service_and_unoffered_slot_are_rejected() -> None:
    tools, _ = executor()
    assert run(tools, "find_available_slots", {"service_id": "nope", "date": SLOT_DATE}).code == (
        "service_not_found"
    )
    assert run(tools, "prepare_booking_review", {"slot_id": "S1"}).code == "slot_not_offered"


def offered_slots(tools: ToolExecutor) -> tuple[Any, ...]:
    outcome = run(tools, "find_available_slots", {"service_id": "flat-repair", "date": SLOT_DATE})
    assert outcome.offered is not None
    return outcome.offered


def test_preparing_a_review_writes_nothing_and_keeps_the_token_out_of_the_model_content() -> None:
    tools, book = executor()
    offered = offered_slots(tools)
    outcome = run(tools, "prepare_booking_review", {"slot_id": "S1"}, offered)

    assert outcome.status == "ok" and outcome.review is not None
    token = outcome.review.wire.proposal_token
    assert ProposalTokenCodec(KEY).decode(token).service_id == "flat-repair"
    assert token not in outcome.content and "v1." not in outcome.content
    assert str(UUID(int=1)) not in outcome.content
    assert "proposal" not in outcome.content.lower()
    assert outcome.review.pending.price_display == "15.00 USD"
    assert book.bookings_overlapping(NOW, NOW.replace(year=2027)) == ()


def test_a_slot_taken_after_it_was_offered_is_rejected_at_review_time() -> None:
    day = date(2026, 10, 6)
    full = [
        local_booking("flat-repair", day, time(9, 0), 30, bench=1),
        local_booking("flat-repair", day, time(9, 0), 30, bench=2),
    ]
    tools, _ = executor()
    offered = offered_slots(tools)  # offered while free
    taken_tools, _ = executor(full)
    outcome = run(taken_tools, "prepare_booking_review", {"slot_id": "S1"}, offered)
    assert (outcome.status, outcome.code) == ("rejected", "slot_unavailable")


@pytest.mark.parametrize(
    ("name", "raw"),
    [
        ("find_available_slots", {"service_id": "flat-repair", "date": "2026-10-06T10:00"}),
        ("find_available_slots", {"service_id": "flat-repair", "date": SLOT_DATE, "days": 0}),
        (
            "find_available_slots",
            {"service_id": "flat-repair", "date": SLOT_DATE, "earliest_local_time": "25:99"},
        ),
        ("find_available_slots", {"service_id": "x" * 65, "date": SLOT_DATE}),
        ("prepare_booking_review", {"slot_id": "S11"}),
        ("prepare_booking_review", {"slot_id": "s1"}),
        ("prepare_booking_review", {"slot_id": "S1", "token": "x"}),
        ("get_business_info", {"anything": 1}),
    ],
)
def test_malformed_arguments_fail_validation(name: str, raw: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        parse_tool_args(name, raw)


def test_tool_input_for_events_is_the_validated_dump() -> None:
    args = parse_tool_args(
        "find_available_slots",
        {"service_id": "flat-repair", "date": SLOT_DATE, "earliest_local_time": "09:30"},
    )
    shown = tool_input_for_event(args)
    assert shown.model_dump(exclude_none=True) == {
        "service_id": "flat-repair",
        "date": SLOT_DATE,
        "days": 1,
        "earliest_local_time": "09:30",
    }


def test_the_read_only_book_reads_but_refuses_every_write() -> None:
    _, book = make_world()
    guarded = ReadOnlyAppointmentBook(book)
    assert guarded.bookings_overlapping(NOW, NOW.replace(year=2027)) == ()
    assert guarded.day_view("flat-repair", NOW)[0].service == FLAT_REPAIR
    with pytest.raises(AgentWriteForbidden):
        guarded.confirm(None, None)  # type: ignore[arg-type]
    with pytest.raises(AgentWriteForbidden):
        guarded.get(UUID(int=1))
