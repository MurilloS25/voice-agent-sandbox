"""A booking review is a pending proposal. Withdrawing it is remembered by the server.

A review is withdrawn when the visitor declines it (the `discard_booking_review` tool), when a
later search names another service or day (deterministically, whatever the model writes), or when
a new review replaces it. The withdrawn proposal can no longer be confirmed, nothing is written,
nothing is "cancelled" (there was no booking), and the replay of a turn is unchanged.
"""

import re
from typing import Any
from uuid import UUID

from fastapi.testclient import TestClient

from tests.agent.support import KEY, SLOT_DATE, AgentWorld, call_tools, kinds, say
from tests.support import NOW, id_sequence
from voice_agent_api.agent.contracts import AgentTurnResponse
from voice_agent_api.factory import create_app

FIND = ("find_available_slots", {"service_id": "flat-repair", "date": SLOT_DATE})
FIND_SAME_AGAIN = (
    "find_available_slots",
    {"service_id": "flat-repair", "date": SLOT_DATE, "earliest_local_time": "12:00"},
)
FIND_OTHER_DAY = ("find_available_slots", {"service_id": "flat-repair", "date": "2026-10-07"})
FIND_OTHER_SERVICE = (
    "find_available_slots",
    {"service_id": "brake-adjustment", "date": SLOT_DATE},
)
PREPARE_1 = ("prepare_booking_review", {"slot_id": "S1"})
PREPARE_2 = ("prepare_booking_review", {"slot_id": "S2"})
DISCARD: tuple[str, dict[str, Any]] = ("discard_booking_review", {})
TOKEN = re.compile(r"v1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")


def with_review(*later_steps: Any) -> tuple[AgentWorld, AgentTurnResponse]:
    """A conversation whose turn 2 prepared a review (turn 1 showed the times)."""
    world = AgentWorld(
        [
            call_tools(FIND),
            say("Here are the times."),
            call_tools(PREPARE_1),
            say("The review is below. Nothing is booked until you press Confirm booking."),
            *later_steps,
        ]
    )
    world.send("What times do you have on Tuesday?")
    review_turn = world.send("The first one, please.")
    assert review_turn.booking_review is not None
    return world, review_turn


def discarded(response: AgentTurnResponse) -> list[str]:
    return [e.reason for e in response.events if e.kind == "booking_review_discarded"]


def pending(world: AgentWorld) -> Any:
    return world.store._entries[world.conversation_id].pending_review


def can_still_confirm(world: AgentWorld, review_turn: AgentTurnResponse) -> bool:
    """Asks the real confirmation route, over HTTP, with the review's own token."""
    app = create_app(
        world.catalog,
        world.book,
        lambda: NOW,
        signing_key=KEY,
        id_factory=id_sequence(),
        agent=world.service,
    )
    assert review_turn.booking_review is not None
    response = TestClient(app).post(
        "/v1/appointments",
        json={"proposal_token": review_turn.booking_review.proposal_token, "confirm": True},
    )
    assert response.status_code in (201, 409), response.text
    if response.status_code == 409:
        assert response.json()["error"]["code"] == "proposal_discarded"
        assert "Nothing was booked" in response.json()["error"]["message"]
    return response.status_code == 201


# -- explicit rejection ------------------------------------------------------------------------


def test_the_visitor_declining_the_review_discards_it_and_it_can_no_longer_be_confirmed() -> None:
    world, review_turn = with_review(
        call_tools(DISCARD), say("No problem, I dropped that proposal. Nothing was booked.")
    )
    response = world.send("Actually, never mind, I do not want that one.")

    assert discarded(response) == ["declined"]
    assert response.booking_review is None  # no new review: nothing left to press
    assert pending(world) is None  # the authoritative state forgot it
    assert not can_still_confirm(world, review_turn)  # the old token is refused by the server
    assert world.stored_bookings() == 0  # discarding wrote nothing
    assert "cancel" not in response.reply.text.lower()


def test_the_discarded_event_carries_display_values_and_never_a_token_or_an_id() -> None:
    world, review_turn = with_review(call_tools(DISCARD), say("Dropped."))
    response = world.send("Never mind.")
    event = next(e for e in response.events if e.kind == "booking_review_discarded")
    assert (event.service_name, event.local_date, event.local_start) == (
        "Flat repair",
        SLOT_DATE,
        "09:00",
    )
    dumped = response.model_dump_json()
    assert not TOKEN.search(dumped) and "proposal_token" not in dumped
    assert review_turn.booking_review is not None
    assert review_turn.booking_review.customer_alias not in dumped


def test_declining_when_nothing_waits_changes_nothing() -> None:
    world = AgentWorld([call_tools(DISCARD), say("There was nothing waiting.")])
    response = world.send("Cancel my review.")
    assert discarded(response) == []
    assert "booking_review_discarded" not in kinds(response)
    assert world.stored_bookings() == 0


# -- a later search replaces the review, whatever the model writes -----------------------------


def test_a_wrong_date_followed_by_a_new_search_discards_the_review() -> None:
    world, review_turn = with_review(
        call_tools(FIND_OTHER_DAY), say("Here is Wednesday. Which time suits you?")
    )
    response = world.send("Wrong date, I meant Wednesday.")

    assert discarded(response) == ["changed_search"]
    assert pending(world) is None
    assert not can_still_confirm(world, review_turn)
    assert world.stored_bookings() == 0


def test_the_discard_does_not_depend_on_the_model_saying_anything_about_it() -> None:
    # The model only searches and answers about the new times: the review is withdrawn anyway.
    world, review_turn = with_review(call_tools(FIND_OTHER_DAY), say("Wednesday times: S1."))
    response = world.send("What about Wednesday?")
    assert discarded(response) == ["changed_search"]
    assert not can_still_confirm(world, review_turn)


def test_a_change_of_service_discards_the_review() -> None:
    world, review_turn = with_review(
        call_tools(FIND_OTHER_SERVICE), say("Here are the brake adjustment times.")
    )
    response = world.send("Actually I need a brake adjustment.")
    assert discarded(response) == ["changed_search"]
    assert not can_still_confirm(world, review_turn)


def test_declining_and_searching_in_one_turn_is_one_discard() -> None:
    world, review_turn = with_review(
        call_tools(DISCARD), call_tools(FIND_OTHER_DAY), say("Wednesday times shown.")
    )
    response = world.send("Wrong date, try Wednesday.")
    assert discarded(response) == ["declined"]  # once, with the first reason
    assert not can_still_confirm(world, review_turn)


# -- a new review replaces the previous one ----------------------------------------------------


def test_a_new_review_replaces_the_previous_one_unambiguously() -> None:
    world, first = with_review(
        call_tools(FIND_SAME_AGAIN),
        say("More times for the same day."),
        call_tools(PREPARE_2),
        say("The new review is below."),
    )
    search_turn = world.send("Anything later in the day?")
    assert discarded(search_turn) == []  # the same service and day: compatible, kept
    assert pending(world) is not None

    second = world.send("Take the second time.")
    assert discarded(second) == ["replaced"]
    assert second.booking_review is not None
    assert pending(world) is not None  # the new one is now the waiting review
    assert first.booking_review is not None
    assert second.booking_review.proposal_token != first.booking_review.proposal_token
    # The old token is refused; the new one still works through the unchanged flow.
    assert not can_still_confirm(world, first)
    assert can_still_confirm(world, second)
    assert world.stored_bookings() == 1


def test_discarding_after_preparing_a_new_review_in_the_same_turn_keeps_the_new_one() -> None:
    world, first = with_review(
        call_tools(FIND_SAME_AGAIN),
        say("More times."),
        call_tools(PREPARE_2, DISCARD),
        say("The new review is below."),
    )
    world.send("Anything later?")
    second = world.send("Take the second one.")
    assert discarded(second) == ["replaced"]
    assert second.booking_review is not None  # the new review stays on screen
    assert pending(world) is not None
    assert not can_still_confirm(world, first)
    assert can_still_confirm(world, second)


# -- compatible questions leave the review alone -----------------------------------------------


def test_a_question_that_does_not_replace_the_review_keeps_it() -> None:
    world, review_turn = with_review(
        call_tools(("get_business_info", {})),
        say("We are open from nine."),
        call_tools(("list_services", {})),
        say("Here are the services."),
        call_tools(FIND_SAME_AGAIN),
        say("The same day, later times."),
    )
    for question in ("When are you open?", "What do you offer?", "Anything later today?"):
        response = world.send(question)
        assert discarded(response) == []
        assert pending(world) is not None
    assert can_still_confirm(world, review_turn)  # still the live, confirmable proposal
    assert world.stored_bookings() == 1


# -- replay, state and exposure ----------------------------------------------------------------


def test_replaying_the_discarding_turn_returns_it_unchanged_and_discards_nothing_twice() -> None:
    world, review_turn = with_review(call_tools(DISCARD), say("Dropped."))
    request = world.request("Never mind.")
    first = world.service.handle_turn(request)
    second = world.service.handle_turn(request)  # the identical retry: the stored answer
    assert first == second
    assert discarded(second) == ["declined"]
    assert len(world.service.discards) == 1
    assert not can_still_confirm(world, review_turn)


def test_an_already_booked_review_is_not_affected_by_a_later_discard() -> None:
    world, review_turn = with_review(call_tools(DISCARD), say("Dropped."))
    # The visitor confirmed first (the booking exists), then the assistant was told to drop it.
    app = create_app(world.catalog, world.book, lambda: NOW, signing_key=KEY, agent=world.service)
    client = TestClient(app)
    assert review_turn.booking_review is not None
    body = {"proposal_token": review_turn.booking_review.proposal_token, "confirm": True}
    assert client.post("/v1/appointments", json=body).status_code == 201
    world.send("Never mind.")
    replay = client.post("/v1/appointments", json=body)
    assert replay.status_code == 200  # idempotent replay of the existing booking, not a refusal
    assert world.stored_bookings() == 1


def test_the_prompt_stops_describing_a_review_that_was_withdrawn() -> None:
    world, _ = with_review(call_tools(DISCARD), say("Dropped."), say("Anything else?"))
    world.send("Never mind.")
    world.send("Thanks.")
    system = " ".join(str(m.content) for m in world.model.calls[-1] if m.type == "system")
    assert "is waiting for the visitor to press Confirm booking" not in system


def test_the_withdrawal_is_remembered_before_the_turn_is_committed() -> None:
    world, review_turn = with_review(call_tools(DISCARD), say("Dropped."))
    seen: list[int] = []
    real_commit = world.store.commit_turn

    def commit(*args: Any, **kwargs: Any) -> bool:
        seen.append(len(world.service.discards))  # what the registry holds at commit time
        return bool(real_commit(*args, **kwargs))

    world.store.commit_turn = commit  # type: ignore[method-assign]
    world.send("Never mind.")
    assert seen == [1]
    assert not can_still_confirm(world, review_turn)


def test_the_registry_forgets_after_the_proposal_could_have_expired() -> None:
    from voice_agent_api.agent.discards import DiscardedProposals

    now = {"t": 0.0}
    registry = DiscardedProposals(retention_s=900, max_entries=3, clock=lambda: now["t"])
    ids = [UUID(int=n) for n in range(1, 6)]
    for proposal_id in ids:
        registry.add(proposal_id)
    assert ids[0] not in registry and ids[1] not in registry  # bounded: the oldest go first
    assert ids[4] in registry
    now["t"] = 901
    assert ids[4] not in registry  # past retention
    assert len(registry) == 0
