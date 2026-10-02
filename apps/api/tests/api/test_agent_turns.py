"""`POST /v1/agent/turns`: the status table, byte-identical retries, races and restart limits."""

import threading
import time
from datetime import timedelta
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from tests.agent.offline import offline_guard
from tests.agent.support import (
    KEY,
    SLOT_DATE,
    AgentWorld,
    blocked_until,
    call_tools,
    say,
)
from tests.agent.test_deadline import RefusingStore
from tests.agent.test_store import ManualClock
from tests.support import NOW, id_sequence, make_world
from voice_agent_api.agent.limits import AgentLimits
from voice_agent_api.agent.store import InMemoryConversationStore
from voice_agent_api.factory import create_app

__all__ = ["offline_guard"]

FIND = ("find_available_slots", {"service_id": "flat-repair", "date": SLOT_DATE})
PREPARE = ("prepare_booking_review", {"slot_id": "S1"})


class Api:
    """The real app with the agent attached, over HTTP."""

    def __init__(self, world: AgentWorld | None = None, **world_kwargs: Any) -> None:
        self.world = world or AgentWorld(**world_kwargs)
        self.app = create_app(
            self.world.catalog,
            self.world.book,
            lambda: NOW,
            signing_key=KEY,
            id_factory=id_sequence(),
            agent=self.world.service,
        )
        self.client = TestClient(self.app, raise_server_exceptions=False)

    def body(
        self,
        message: str = "hello",
        *,
        index: int = 1,
        turn: str | None = None,
        conversation: str | None = None,
    ) -> dict[str, Any]:
        return {
            "conversation_id": conversation or str(self.world.conversation_id),
            "client_turn_id": turn or str(uuid4()),
            "turn_index": index,
            "message": message,
        }

    def post(self, body: dict[str, Any]) -> Any:
        return self.client.post("/v1/agent/turns", json=body)


def error_code(response: Any) -> str:
    return str(response.json()["error"]["code"])


# -- success and degraded ----------------------------------------------------------------------


def test_a_completed_turn_returns_the_typed_response() -> None:
    api = Api(steps=[say("We repair everyday bikes.")])
    response = api.post(api.body("What do you do?"))

    assert response.status_code == 200
    data = response.json()
    assert data["outcome"] == "completed"
    assert data["reply"] == {"source": "assistant", "text": "We repair everyday bikes."}
    assert data["turn_index"] == 1
    assert [e["kind"] for e in data["events"]] == ["user_message", "assistant_message"]
    assert data["booking_review"] is None


def test_a_provider_failure_is_a_200_degraded_response() -> None:
    api = Api(steps=[RuntimeError("provider down")])
    response = api.post(api.body())

    assert response.status_code == 200
    assert response.json()["outcome"] == "degraded"
    assert response.json()["reply"]["source"] == "system"
    assert "provider down" not in response.text


def test_the_agent_prepares_a_review_and_only_the_existing_endpoint_can_confirm_it() -> None:
    api = Api(steps=[call_tools(FIND), say("times"), call_tools(PREPARE), say("review below")])
    api.post(api.body("times", index=1))
    reviewed = api.post(api.body("first", index=2)).json()
    review = reviewed["booking_review"]

    assert review is not None
    assert api.world.stored_bookings() == 0  # nothing booked by the agent

    confirm = api.client.post(
        "/v1/appointments", json={"proposal_token": review["proposal_token"], "confirm": True}
    )
    assert confirm.status_code == 201
    assert confirm.json()["service"]["id"] == "flat-repair"
    assert api.world.stored_bookings() == 1


def test_a_model_that_tries_to_confirm_creates_nothing() -> None:
    api = Api(
        steps=[
            call_tools(("confirm_appointment", {"proposal_token": "x", "confirm": True})),
            say("I can't book."),
        ]
    )
    response = api.post(api.body("book it for me"))

    assert response.status_code == 200
    assert any(e["kind"] == "guardrail" for e in response.json()["events"])
    assert api.world.stored_bookings() == 0


# -- the status table --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "patch",
    [
        {"message": ""},
        {"message": "   "},
        {"message": "x" * 501},
        {"message": "bad\x00char"},
        {"turn_index": 0},
        {"turn_index": 31},
        {"conversation_id": "not-a-uuid"},
        {"client_turn_id": 5},
        {"extra": "field"},
    ],
)
def test_invalid_requests_are_422_and_accept_nothing(patch: dict[str, Any]) -> None:
    api = Api(steps=[say("never")])
    response = api.post({**api.body(), **patch})

    assert response.status_code == 422
    assert error_code(response) == "validation_error"
    assert api.world.model.calls == []


def test_a_missing_field_is_422() -> None:
    api = Api()
    body = api.body()
    del body["message"]
    assert api.post(body).status_code == 422


def test_without_a_provider_the_route_is_503_and_creates_nothing() -> None:
    catalog, book = make_world()
    app = create_app(catalog, book, lambda: NOW, signing_key=KEY)  # agent=None
    client = TestClient(app, raise_server_exceptions=False)
    response = client.post(
        "/v1/agent/turns",
        json={
            "conversation_id": str(uuid4()),
            "client_turn_id": str(uuid4()),
            "turn_index": 1,
            "message": "hi",
        },
    )
    assert response.status_code == 503
    assert error_code(response) == "agent_unavailable"
    # Neutral wording: no alternative booking path is suggested.
    assert response.json()["error"]["message"] == (
        "The workshop assistant is temporarily unavailable. Please try again shortly."
    )
    # Read-only endpoints are unaffected.
    assert client.get("/v1/services").status_code == 200


def test_an_unknown_conversation_is_404_after_the_first_turn() -> None:
    api = Api()
    response = api.post(api.body(index=2))
    assert (response.status_code, error_code(response)) == (404, "conversation_not_found")


def test_an_expired_conversation_is_410() -> None:
    clock = ManualClock()
    api = Api(steps=[say("hi")], store=InMemoryConversationStore(clock))
    assert api.post(api.body(index=1)).status_code == 200
    clock.advance(timedelta(minutes=31))

    response = api.post(api.body(index=2))
    assert (response.status_code, error_code(response)) == (410, "conversation_expired")


def test_a_reused_key_is_409() -> None:
    api = Api(steps=[say("hi")])
    turn = str(uuid4())
    assert api.post(api.body("one", turn=turn)).status_code == 200

    response = api.post(api.body("two", turn=turn))
    assert (response.status_code, error_code(response)) == (409, "idempotency_key_reused")


def test_an_out_of_order_turn_is_409() -> None:
    api = Api(steps=[say("hi")])
    api.post(api.body(index=1))
    response = api.post(api.body(index=3))
    assert (response.status_code, error_code(response)) == (409, "turn_out_of_order")


def test_the_turn_limit_is_409() -> None:
    api = Api(steps=[say("hi")], store=InMemoryConversationStore(lambda: NOW, max_turns=1))
    api.post(api.body(index=1))
    response = api.post(api.body(index=2))
    assert (response.status_code, error_code(response)) == (409, "conversation_limit_reached")


def test_a_failed_commit_is_a_500_that_leaks_nothing_and_frees_the_turn() -> None:
    api = Api(steps=[say("one"), say("two")], store=RefusingStore(lambda: NOW))
    body = api.body()
    first = api.post(body)

    assert first.status_code == 500
    assert error_code(first) == "internal_error"
    assert api.post(body).status_code == 500  # accepted again, not "turn_in_progress"


# -- idempotent retries ------------------------------------------------------------------------


def test_a_lost_first_response_is_replayed_byte_for_byte_without_calling_the_model() -> None:
    api = Api(steps=[call_tools(FIND), say("times")])
    body = api.body("times?", index=1)
    original = api.post(body)
    retry = api.post(body)

    assert retry.status_code == 200
    assert retry.content == original.content
    assert len(api.world.model.calls) == 2  # the two calls of the one real turn


def test_an_earlier_turn_is_replayed_byte_for_byte_after_later_turns() -> None:
    api = Api(steps=[say("one"), say("two"), say("three")])
    bodies = [api.body(f"m{i}", index=i) for i in (1, 2, 3)]
    originals = [api.post(b) for b in bodies]

    assert api.post(bodies[0]).content == originals[0].content
    assert api.post(bodies[1]).content == originals[1].content
    assert len(api.world.model.calls) == 3


# -- concurrency -------------------------------------------------------------------------------


def wait_until(condition: Any, timeout: float = 3.0) -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError("condition not reached")


def test_a_same_key_retry_while_in_flight_is_409_turn_in_progress_with_one_model_call() -> None:
    release = threading.Event()
    api = Api(steps=[blocked_until(release, say("done"))])
    body = api.body()
    first: list[Any] = []
    worker = threading.Thread(target=lambda: first.append(api.post(body)))
    worker.start()
    wait_until(lambda: len(api.world.model.calls) == 1)

    retry = api.post(body)
    assert (retry.status_code, error_code(retry)) == (409, "turn_in_progress")
    assert retry.headers["retry-after"] == "2"

    release.set()
    worker.join(5)
    assert first[0].status_code == 200
    assert api.post(body).content == first[0].content
    assert len(api.world.model.calls) == 1


def test_a_different_turn_while_one_is_in_flight_is_409_busy_and_consumes_nothing() -> None:
    release = threading.Event()
    api = Api(steps=[blocked_until(release, say("one")), say("two")])
    first: list[Any] = []
    worker = threading.Thread(target=lambda: first.append(api.post(api.body(index=1))))
    worker.start()
    wait_until(lambda: len(api.world.model.calls) == 1)

    busy = api.post(api.body(index=2))
    assert (busy.status_code, error_code(busy)) == (409, "conversation_busy")
    assert busy.headers["retry-after"] == "2"

    release.set()
    worker.join(5)
    assert api.post(api.body(index=2)).status_code == 200  # the turn number was not consumed


def test_the_global_cap_is_429_with_retry_after_and_releases_the_marker() -> None:
    release = threading.Event()
    world = AgentWorld(
        [blocked_until(release, say("one"))], limits=AgentLimits(max_in_flight_turns=1)
    )
    api = Api(world)
    worker = threading.Thread(target=lambda: api.post(api.body(index=1)))
    worker.start()
    wait_until(lambda: len(world.model.calls) == 1)

    other = api.body(conversation=str(uuid4()))
    busy = api.post(other)
    assert (busy.status_code, error_code(busy)) == (429, "agent_busy")
    assert busy.headers["retry-after"] == "5"

    release.set()
    worker.join(5)
    world.model.add_steps(say("free now"))
    assert api.post(other).status_code == 200  # the refused turn left nothing behind


# -- limits of process-scoped idempotency ------------------------------------------------------


def test_after_a_restart_later_turns_are_404_and_a_first_turn_is_new_but_cannot_book() -> None:
    first = Api(steps=[say("hello")])
    first_body = first.body("hello", index=1)
    assert first.post(first_body).status_code == 200

    # A new process: fresh store, same appointment book and the same ids from the browser.
    restarted_world = AgentWorld(
        [call_tools(("confirm_appointment", {"proposal_token": "x"})), say("again")],
        store=InMemoryConversationStore(lambda: NOW),
    )
    restarted = Api(restarted_world)
    assert restarted.post({**first_body, "turn_index": 2}).status_code == 404

    replayed = restarted.post(first_body)  # a retried first turn: indistinguishable from new
    assert replayed.status_code == 200
    assert len(restarted_world.model.calls) == 2  # the model ran again
    assert restarted_world.stored_bookings() == 0  # and still cannot book
    assert replayed.json()["booking_review"] is None
