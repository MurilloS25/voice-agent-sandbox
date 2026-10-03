import logging
import re
import secrets
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.support import FLAT_REPAIR, NOW, SLOT_START, id_sequence, make_world
from voice_agent_api.domain.errors import StorageUnavailable
from voice_agent_api.domain.models import Booking, Money
from voice_agent_api.factory import create_app
from voice_agent_api.infrastructure.in_memory import InMemoryAppointmentBook

UUID_SHAPE = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

KEY = secrets.token_bytes(32)
START = "2026-10-06T14:00:00Z"


class World:
    def __init__(self, bookings: list[Booking] | None = None) -> None:
        self.now = NOW
        self.catalog, self.book = make_world(bookings or [])
        self.app = create_app(
            self.catalog,
            self.book,
            lambda: self.now,
            signing_key=KEY,
            id_factory=id_sequence(),
        )
        self.client = TestClient(self.app, raise_server_exceptions=False)

    def propose(self, start: str = START, service_id: str = "flat-repair") -> Any:
        return self.client.post(
            "/v1/appointment-proposals", json={"service_id": service_id, "start": start}
        )

    def confirm(self, token: str, *, confirm: object = True) -> Any:
        return self.client.post(
            "/v1/appointments", json={"proposal_token": token, "confirm": confirm}
        )

    def token(self) -> str:
        response = self.propose()
        assert response.status_code == 200, response.text
        return str(response.json()["proposal_token"])

    def stored(self) -> int:
        return len(
            self.book.bookings_overlapping(
                datetime(2026, 10, 6, tzinfo=UTC), datetime(2026, 10, 8, tzinfo=UTC)
            )
        )


def test_proposal_describes_the_booking_and_writes_nothing() -> None:
    world = World()
    response = world.propose()

    assert response.status_code == 200
    body = response.json()
    assert body["start"] == START
    assert body["end"] == "2026-10-06T14:30:00Z"
    assert body["timezone"] == "America/New_York"
    assert body["service"]["id"] == "flat-repair"
    assert body["service"]["price"] == {"amount_minor": 1500, "currency": "USD"}
    assert body["customer_alias"].startswith("Demo ")
    assert body["expires_at"] == "2026-09-30T12:10:00Z"
    assert body["proposal_token"].startswith("v1.")
    assert world.stored() == 0


def test_proposal_accepts_any_utc_offset() -> None:
    assert World().propose("2026-10-06T10:00:00-04:00").status_code == 200


@pytest.mark.parametrize(
    ("start", "service", "status", "code"),
    [
        ("2026-10-06T14:00:00", "flat-repair", 422, "validation_error"),  # naive
        ("not-a-date", "flat-repair", 422, "validation_error"),
        ("2026-10-06T14:15:00Z", "flat-repair", 422, "slot_not_offered"),
        ("2026-10-20T14:00:00Z", "flat-repair", 422, "date_out_of_range"),
        (START, "nope", 404, "service_not_found"),
    ],
)
def test_proposal_errors_use_the_envelope_and_echo_nothing(
    start: str, service: str, status: int, code: str
) -> None:
    response = World().propose(start, service)
    assert response.status_code == status
    assert response.json()["error"]["code"] == code
    for submitted in (start, service):
        if submitted not in ("flat-repair", START):
            assert submitted not in response.text


def test_proposal_for_a_full_slot_is_a_conflict() -> None:
    end = SLOT_START + timedelta(minutes=30)
    world = World([Booking("x", SLOT_START, end, 1), Booking("y", SLOT_START, end, 2)])
    response = world.propose()
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "slot_unavailable"


def test_confirm_creates_then_replays_with_an_identical_body() -> None:
    world = World()
    review = world.propose().json()
    token = review["proposal_token"]

    created = world.confirm(token)
    replay = world.confirm(token)

    assert created.status_code == 201
    assert replay.status_code == 200
    assert replay.json() == created.json()
    body = created.json()
    assert body["status"] == "confirmed"
    assert body["bench"] == 1
    assert body["source"] == "web_demo"
    assert body["customer_alias"] == review["customer_alias"]
    assert body["start"] == review["start"]
    assert body["end"] == review["end"]
    # The saved record carries the booked service's id, name, duration and price.
    assert body["service"] == {
        key: review["service"][key] for key in ("id", "name", "duration_minutes", "price")
    }
    assert body["timezone"] == "America/New_York"
    assert world.stored() == 1


def test_get_returns_the_saved_appointment() -> None:
    world = World()
    created = world.confirm(world.token()).json()
    fetched = world.client.get(f"/v1/appointments/{created['id']}")
    assert fetched.status_code == 200
    assert fetched.json() == created


def test_get_unknown_and_malformed_ids() -> None:
    world = World()
    missing = world.client.get("/v1/appointments/00000000-0000-0000-0000-000000000000")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "appointment_not_found"
    assert "00000000" not in missing.text
    malformed = world.client.get("/v1/appointments/not-a-uuid")
    assert malformed.status_code == 422
    assert malformed.json()["error"]["code"] == "validation_error"


@pytest.mark.parametrize("confirm", [False, None, "true", 1, 0])
def test_confirm_requires_an_explicit_true(confirm: object) -> None:
    world = World()
    response = world.confirm(world.token(), confirm=confirm)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert world.stored() == 0


def test_confirm_without_the_flag_or_with_a_non_json_body_is_rejected() -> None:
    world = World()
    token = world.token()
    missing = world.client.post("/v1/appointments", json={"proposal_token": token})
    assert missing.status_code == 422
    plain = world.client.post(
        "/v1/appointments",
        content=f'{{"proposal_token": "{token}", "confirm": true}}',
        headers={"content-type": "text/plain"},
    )
    assert plain.status_code == 422
    assert world.stored() == 0


def test_an_invalid_token_is_rejected_without_echo() -> None:
    world = World()
    token = world.token()
    tampered = token[:-2] + ("AA" if not token.endswith("AA") else "BB")
    for bad in (tampered, "garbage", "v1.a.b"):
        response = world.confirm(bad)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "proposal_invalid"
        assert bad not in response.text
    assert world.stored() == 0


def test_an_expired_proposal_is_rejected_but_a_replay_still_works() -> None:
    world = World()
    token = world.token()
    world.now = NOW + timedelta(minutes=11)
    expired = world.confirm(token)
    assert expired.status_code == 422
    assert expired.json()["error"]["code"] == "proposal_expired"
    assert world.stored() == 0

    world.now = NOW
    fresh = world.token()
    created = world.confirm(fresh)
    world.now = NOW + timedelta(hours=1)
    replay = world.confirm(fresh)
    assert (created.status_code, replay.status_code) == (201, 200)
    assert replay.json() == created.json()


def test_the_third_booking_for_a_two_bench_slot_conflicts() -> None:
    world = World()
    tokens = [world.token() for _ in range(3)]
    assert [world.confirm(t).status_code for t in tokens] == [201, 201, 409]
    conflict = world.confirm(tokens[2])
    assert conflict.json()["error"]["code"] == "slot_unavailable"
    assert world.stored() == 2


def test_stale_flow_writes_nothing_then_a_fresh_review_succeeds() -> None:
    world = World()
    reviewed = world.propose().json()
    token = reviewed["proposal_token"]
    world.catalog.set_service(replace(FLAT_REPAIR, price=Money(1600, "USD")))

    stale = world.confirm(token)

    assert stale.status_code == 409
    assert stale.json() == {
        "error": {
            "code": "proposal_stale",
            "message": "The service details changed since you reviewed this booking. "
            "Review it again.",
        }
    }
    assert "1500" not in stale.text and "1600" not in stale.text
    assert token not in stale.text
    assert world.stored() == 0

    again = world.propose().json()
    assert again["service"]["price"]["amount_minor"] == 1600
    created = world.confirm(again["proposal_token"])
    assert created.status_code == 201
    assert created.json()["service"]["price"]["amount_minor"] == 1600


def test_a_replay_after_a_catalog_change_returns_an_identical_body() -> None:
    world = World()
    token = world.token()
    created = world.confirm(token)
    # Change everything a stale appointment page could show: name, duration and price.
    world.catalog.set_service(
        replace(
            FLAT_REPAIR, name="Flat fix", duration=timedelta(minutes=45), price=Money(9900, "USD")
        )
    )

    replay = world.confirm(token)
    fetched = world.client.get(f"/v1/appointments/{created.json()['id']}")

    assert replay.status_code == 200
    assert replay.json() == created.json()  # the whole body, not just the id
    assert fetched.json() == created.json()
    saved = created.json()["service"]
    assert (saved["name"], saved["duration_minutes"], saved["price"]["amount_minor"]) == (
        "Flat repair",
        30,
        1500,
    )


def test_each_proposal_gets_a_distinct_token_and_alias_input() -> None:
    world = World()
    first, second = world.propose().json(), world.propose().json()
    assert first["proposal_token"] != second["proposal_token"]


class FailingBook(InMemoryAppointmentBook):
    def confirm(self, proposal: Any, decide: Any) -> Any:
        raise StorageUnavailable

    def bookings_overlapping(self, start: datetime, end: datetime) -> Any:
        raise StorageUnavailable

    def day_view(self, service_id: str, when: Any) -> Any:
        raise StorageUnavailable


def test_storage_failures_return_the_fixed_503_without_a_traceback(
    caplog: pytest.LogCaptureFixture,
) -> None:
    world_catalog, _ = make_world()
    book = FailingBook(world_catalog, clock=lambda: NOW)
    app = create_app(world_catalog, book, lambda: NOW, signing_key=KEY)
    client = TestClient(app, raise_server_exceptions=False)

    with caplog.at_level(logging.DEBUG):
        proposal = client.post(
            "/v1/appointment-proposals", json={"service_id": "flat-repair", "start": START}
        )
        availability = client.get(
            "/v1/services/flat-repair/availability", params={"date": "2026-10-06"}
        )

    for response in (proposal, availability):
        assert response.status_code == 503
        assert response.json() == {
            "error": {
                "code": "storage_unavailable",
                "message": "The schedule service is temporarily unavailable.",
            }
        }
    assert "Traceback" not in caplog.text


def test_confirm_outcomes_are_audited_without_tokens_aliases_or_submitted_ids(
    caplog: pytest.LogCaptureFixture,
) -> None:
    world = World()
    review = world.propose().json()
    token = review["proposal_token"]
    stale_review = world.propose().json()

    with caplog.at_level(logging.DEBUG, logger="voice_agent_api"):
        created = world.confirm(token)
        replayed = world.confirm(token)
        world.catalog.set_service(replace(FLAT_REPAIR, price=Money(1600, "USD")))
        stale = world.confirm(stale_review["proposal_token"])
        world.client.get("/v1/appointments/00000000-0000-0000-0000-000000000000")

    assert (created.status_code, replayed.status_code, stale.status_code) == (201, 200, 409)
    lines = [r.getMessage() for r in caplog.records]
    appointment_id = created.json()["id"]
    # Exactly the sanitized outcome events, in order: no identifier of any kind.
    assert [line for line in lines if line.startswith("appointment_confirm")] == [
        "appointment_confirm outcome=created",
        "appointment_confirm outcome=replayed",
    ]
    assert "domain_error code=proposal_stale method=POST route=/v1/appointments" in lines
    assert (
        "domain_error code=appointment_not_found method=GET route=/v1/appointments/{appointment_id}"
        in lines
    )

    everything = caplog.text
    for secret in (token, stale_review["proposal_token"], review["customer_alias"]):
        assert secret not in everything
    assert "00000000-0000-0000-0000-000000000000" not in everything  # a submitted id, not logged
    assert appointment_id not in everything  # the real appointment's id is not logged either
    assert "appointment_id=" not in everything
    assert not re.search(UUID_SHAPE, everything), "an identifier-shaped value was logged"
    assert replayed.json()["id"] == appointment_id  # and the replay still answers the same row


def test_an_unexpected_error_logs_the_route_template_never_the_appointment_id(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class ExplodingBook(InMemoryAppointmentBook):
        def get(self, appointment_id: Any) -> Any:
            raise RuntimeError("boom")

    catalog, _ = make_world()
    app = create_app(
        catalog, ExplodingBook(catalog, clock=lambda: NOW), lambda: NOW, signing_key=KEY
    )
    client = TestClient(app, raise_server_exceptions=False)
    requested = "5b0c8e7a-1d3f-4a6b-9c2e-7f1a2b3c4d5e"

    with caplog.at_level(
        logging.DEBUG, logger="voice_agent_api"
    ):  # the app's logs, not the client's
        response = client.get(f"/v1/appointments/{requested}")

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"
    messages = [r.getMessage() for r in caplog.records]
    assert "Unhandled error on GET /v1/appointments/{appointment_id} error=RuntimeError" in messages
    assert requested not in caplog.text
    assert not re.search(UUID_SHAPE, caplog.text)
