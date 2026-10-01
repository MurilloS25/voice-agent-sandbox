from fastapi import FastAPI
from fastapi.testclient import TestClient

from tests.support import NOW
from voice_agent_api.factory import create_app
from voice_agent_api.infrastructure.seed import build_seed


def make_app() -> FastAPI:
    catalog, appointments = build_seed(NOW)
    return create_app(catalog, appointments, lambda: NOW)


def make_client() -> TestClient:
    return TestClient(make_app())


def test_health() -> None:
    response = make_client().get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_business_exposes_timezone_currency_hours_and_window() -> None:
    body = make_client().get("/v1/business").json()
    assert body["name"] == "Quillwheel Cycle Works"
    assert body["timezone"] == "America/New_York"
    assert body["currency"] == "USD"
    assert body["phone"].startswith("+1 212-555-01")
    assert len(body["hours"]) == 9  # Tue-Fri split days plus Saturday morning
    assert body["booking_window"] == {"first_date": "2026-09-30", "last_date": "2026-10-14"}


def test_services_lists_durations_and_prices() -> None:
    body = make_client().get("/v1/services").json()
    by_id = {s["id"]: s for s in body["services"]}
    assert len(by_id) == 5
    assert by_id["flat-repair"]["duration_minutes"] == 30
    assert by_id["flat-repair"]["price"] == {"amount_minor": 1500, "currency": "USD"}
    assert by_id["full-overhaul"]["duration_minutes"] == 240


def test_availability_returns_utc_slots_and_respects_seed_bookings() -> None:
    # Thursday 2026-10-01: both benches are busy 10:00-11:30 local (seed tune-ups).
    response = make_client().get(
        "/v1/services/flat-repair/availability", params={"date": "2026-10-01"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["service_id"] == "flat-repair"
    assert body["date"] == "2026-10-01"
    assert body["timezone"] == "America/New_York"
    starts = [slot["start"] for slot in body["slots"]]
    assert starts[0] == "2026-10-01T13:00:00Z"  # 09:00 EDT
    assert body["slots"][0]["end"] == "2026-10-01T13:30:00Z"
    assert "2026-10-01T14:00:00Z" not in starts  # 10:00 EDT, both benches busy
    assert "2026-10-01T15:00:00Z" not in starts  # 11:00 EDT, still overlaps until 11:30
    assert "2026-10-01T15:30:00Z" in starts  # 11:30 EDT, benches free again


def test_availability_on_a_closed_day_is_empty() -> None:
    response = make_client().get(
        "/v1/services/flat-repair/availability",
        params={"date": "2026-10-05"},  # Monday
    )
    assert response.status_code == 200
    assert response.json()["slots"] == []


def test_unknown_service_returns_404_envelope() -> None:
    response = make_client().get("/v1/services/nope/availability", params={"date": "2026-10-01"})
    assert response.status_code == 404
    assert response.json() == {
        "error": {"code": "service_not_found", "message": "No service matches that id."}
    }
    assert "nope" not in response.text  # the submitted id is not echoed back


def test_timestamp_is_not_accepted_as_a_date() -> None:
    for value in ("2026-10-02T00:00:00", "2026-10-02 00:00", "20261002", "2026-10-2"):
        response = make_client().get(
            "/v1/services/flat-repair/availability", params={"date": value}
        )
        assert response.status_code == 422, value
        assert response.json()["error"]["code"] == "validation_error"


def test_unknown_route_and_wrong_method_use_the_error_envelope() -> None:
    client = make_client()

    missing = client.get("/nope")
    assert missing.status_code == 404
    assert missing.json() == {"error": {"code": "not_found", "message": "Not Found"}}

    wrong_method = client.post("/health")
    assert wrong_method.status_code == 405
    assert wrong_method.json() == {
        "error": {"code": "method_not_allowed", "message": "Method Not Allowed"}
    }


def test_malformed_date_returns_validation_envelope_without_echoing_input() -> None:
    response = make_client().get(
        "/v1/services/flat-repair/availability", params={"date": "not-a-date"}
    )
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert error["details"][0]["loc"] == ["query", "date"]
    assert "not-a-date" not in response.text


def test_missing_date_returns_validation_envelope() -> None:
    response = make_client().get("/v1/services/flat-repair/availability")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_date_outside_window_returns_422_envelope() -> None:
    response = make_client().get(
        "/v1/services/flat-repair/availability", params={"date": "2026-10-15"}
    )
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "date_out_of_range"
    assert "2026-09-30 to 2026-10-14" in error["message"]


def test_unhandled_exception_returns_generic_500_envelope() -> None:
    app = make_app()

    @app.get("/boom")
    def boom() -> None:
        raise RuntimeError("secret-internal-detail")

    # raise_server_exceptions=False makes TestClient return the 500 response that a real
    # server would send, instead of re-raising the exception into the test.
    client = TestClient(app, raise_server_exceptions=False)
    response = client.get("/boom")

    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Something went wrong."}
    }
    assert "secret-internal-detail" not in response.text
