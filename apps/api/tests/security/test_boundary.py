"""Body limits, draining, the last-resort error handler, readiness, CORS and log hygiene."""

import asyncio
import logging
import uuid
from collections.abc import MutableMapping
from typing import Any

import httpx
import pytest

from tests.agent.support import call_tools
from tests.security.support import AUTH, CLIENT_A, SECRET, Protected
from voice_agent_api.security.auth import secret_digest
from voice_agent_api.security.middleware import Protection, ProtectionMiddleware

SENTINEL = "SENTINEL-visitor-text-7f3a91"
APPOINTMENT_ID = "11111111-2222-4333-8444-555555555555"


def body(api: Protected, message: str = "hi", index: int = 1) -> dict[str, Any]:
    return {
        "conversation_id": str(api.world.conversation_id),
        "client_turn_id": str(uuid.uuid4()),
        "turn_index": index,
        "message": message,
    }


# --- input limits ----------------------------------------------------------------------------


def test_a_json_body_over_the_limit_is_refused_before_the_app_sees_it() -> None:
    api = Protected(json_body_limit=1024, steps=[])
    payload = body(api, "x" * 2000)
    response = api.client.post("/v1/agent/turns", headers=AUTH, json=payload)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "body_too_large"
    assert "x" * 50 not in response.text
    assert len(api.world.model.calls) == 0


def test_the_content_length_alone_can_reject_early() -> None:
    api = Protected(json_body_limit=1024)
    response = api.client.post(
        "/v1/agent/turns",
        headers={**AUTH, "Content-Length": "5000", "Content-Type": "application/json"},
        content=b"{}",
    )
    assert response.status_code == 413


def test_a_body_that_lies_about_its_length_is_still_bounded() -> None:
    async def run() -> int:
        api = Protected(json_body_limit=1024)
        transport = httpx.ASGITransport(app=api.app)

        async def chunks() -> Any:
            for _ in range(10):
                yield b"x" * 400  # 4,000 bytes streamed, no Content-Length

        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/v1/agent/turns",
                headers={**AUTH, "Content-Type": "application/json"},
                content=chunks(),
            )
        return response.status_code

    assert asyncio.run(run()) == 413


def test_a_body_at_the_limit_goes_through_intact() -> None:
    api = Protected(json_body_limit=64 * 1024)
    payload = body(api, "y" * 400)
    response = api.client.post("/v1/agent/turns", headers=AUTH, json=payload)
    assert response.status_code == 200  # 400 characters is a valid message: nothing was lost


def test_a_valid_small_turn_reaches_the_agent_with_its_body_unchanged() -> None:
    api = Protected()
    response = api.client.post("/v1/agent/turns", headers=AUTH, json=body(api, "hello there"))
    assert response.status_code == 200
    assert response.json()["events"][0]["text"] == "hello there"


def test_a_slow_body_is_cut_off() -> None:
    async def run() -> int:
        api = Protected()
        transport = httpx.ASGITransport(app=api.app)

        async def slow() -> Any:
            yield b'{"conversation_id": '
            await asyncio.sleep(2)  # the layer allows 0.5 s in these tests
            yield b"1}"

        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/v1/agent/turns",
                headers={**AUTH, "Content-Type": "application/json"},
                content=slow(),
            )
        return response.status_code

    assert asyncio.run(run()) == 408


def test_the_audio_limit_still_applies_to_the_speech_route() -> None:
    from voice_agent_api.speech.limits import SpeechLimits

    api = Protected(speech_limits=SpeechLimits(max_audio_bytes=2048))
    response = api.client.post(
        "/v1/speech/transcriptions",
        headers={**AUTH, "Content-Type": "audio/wav"},
        content=b"RIFF" + bytes(4096),
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "audio_too_large"


# --- draining ---------------------------------------------------------------------------------


def test_costly_requests_are_refused_while_draining_but_reads_still_answer() -> None:
    api = Protected(steps=[])
    api.app.state.draining = True
    turn = api.client.post("/v1/agent/turns", headers=AUTH, json=body(api))
    speech = api.client.post(
        "/v1/speech/transcriptions", headers={**AUTH, "Content-Type": "audio/wav"}, content=b"RIFF"
    )
    assert turn.status_code == speech.status_code == 503
    assert turn.json()["error"]["code"] == "service_draining"
    assert turn.headers["retry-after"] == "5"
    assert len(api.world.model.calls) == 0
    assert api.client.get("/v1/business", headers=AUTH).status_code == 200


def test_readiness_is_false_while_draining_and_liveness_stays_true() -> None:
    api = Protected()
    api.app.state.draining = True
    assert api.client.get("/health/ready").status_code == 503
    assert api.client.get("/health/ready").json() == {"status": "draining"}
    assert api.client.get("/health/live").status_code == 200


def test_shutdown_turns_draining_on_before_the_resources_close_and_forgets_conversations() -> None:
    order: list[str] = []
    api = Protected()
    original_close = api.world.service.close

    def close() -> None:
        order.append(f"close draining={api.app.state.draining}")
        original_close()

    api.world.service.close = close  # type: ignore[method-assign]
    with api.client as client:
        assert client.get("/health/ready").json() == {"status": "ready"}
        client.post("/v1/agent/turns", headers=AUTH, json=body(api, "remember me"))
    assert order == ["close draining=True"]
    assert api.world.store._entries == {}  # nothing outlives the process


# --- readiness --------------------------------------------------------------------------------


def test_readiness_follows_the_check_and_says_only_a_status_word() -> None:
    state = {"up": True}
    api = Protected(ready_check=lambda: state["up"])
    assert api.client.get("/health/ready").json() == {"status": "ready"}
    state["up"] = False
    response = api.client.get("/health/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}
    assert response.headers["cache-control"] == "no-store"


def test_readiness_never_touches_the_provider_or_the_agent() -> None:
    api = Protected(steps=[])
    api.client.get("/health/ready")
    api.client.get("/health/live")
    assert len(api.world.model.calls) == 0
    assert api.speech_port.calls == 0


# --- the last-resort error handler --------------------------------------------------------------


def test_an_unexpected_error_becomes_a_generic_500_with_a_random_correlation_id(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    api = Protected()

    @api.app.get("/boom")
    def boom() -> None:
        raise RuntimeError(f"driver said Key (id)=({APPOINTMENT_ID}) {SENTINEL}")

    response = api.client.get("/boom", headers=AUTH)
    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Something went wrong."}
    }
    correlation = response.headers["x-correlation-id"]
    assert len(correlation) == 8 and all(c in "0123456789abcdef" for c in correlation)
    logged = " ".join(r.getMessage() for r in caplog.records) + " ".join(
        str(r.exc_info) for r in caplog.records if r.exc_info
    )
    assert SENTINEL not in logged and APPOINTMENT_ID not in logged and SENTINEL not in response.text
    assert "RuntimeError" in logged and correlation in logged
    assert all(r.exc_info is None for r in caplog.records)  # no traceback by default


def test_a_traceback_is_logged_only_when_explicitly_enabled() -> None:
    api = Protected(log_tracebacks=True)

    @api.app.get("/boom")
    def boom() -> None:
        raise RuntimeError("visible only in development")

    records: list[logging.LogRecord] = []

    class Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    handler = Capture()
    logging.getLogger("voice_agent_api").addHandler(handler)
    try:
        assert api.client.get("/boom", headers=AUTH).status_code == 500
    finally:
        logging.getLogger("voice_agent_api").removeHandler(handler)
    assert any(r.exc_info for r in records)


def test_the_error_handler_does_not_hide_normal_http_errors() -> None:
    api = Protected()
    assert (
        api.client.get("/v1/services/nope/availability?date=2026-10-06", headers=AUTH).status_code
        == 404
    )
    assert api.client.post("/v1/business", headers=AUTH).status_code == 405


# --- CORS and proxies -----------------------------------------------------------------------------


def test_the_api_never_sends_cors_headers() -> None:
    api = Protected()
    origin = {"Origin": "https://evil.example"}
    for path in ("/v1/business", "/health/live", "/v1/services"):
        response = api.client.get(path, headers={**AUTH, **origin})
        assert not any(k.lower().startswith("access-control-") for k in response.headers)
    preflight = api.client.options(
        "/v1/agent/turns",
        headers={
            **origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert preflight.status_code in (401, 405)
    assert not any(k.lower().startswith("access-control-") for k in preflight.headers)


def test_the_app_has_no_cors_or_proxy_header_middleware() -> None:
    api = Protected()
    assert [str(m.cls) for m in api.app.user_middleware] == [str(ProtectionMiddleware)]


# --- logs carry nothing a visitor said ---


def test_no_route_logs_visitor_text_identifiers_tokens_or_client_ids(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    api = Protected(
        steps=[
            call_tools(
                ("find_available_slots", {"service_id": "flat-repair", "date": "2026-10-06"})
            )
        ]
        + [__import__("tests.agent.support", fromlist=["say"]).say(f"reply {SENTINEL}")] * 20
    )
    headers = {**AUTH, "X-Client-Id": CLIENT_A}
    api.client.post("/v1/agent/turns", headers=headers, json=body(api, f"text {SENTINEL}"))
    api.client.get(f"/v1/appointments/{APPOINTMENT_ID}", headers=headers)
    api.client.get(
        f"/v1/services/{SENTINEL}/availability?date=2026-10-06&token={SENTINEL}", headers=headers
    )
    api.client.post(
        "/v1/appointments", headers=headers, json={"proposal_token": SENTINEL, "confirm": True}
    )
    api.client.post(
        "/v1/speech/transcriptions",
        headers={**headers, "Content-Type": "audio/wav", "X-Audio-Duration-Ms": "x"},
        content=SENTINEL.encode(),
    )
    api.client.get(f"/{SENTINEL}/{APPOINTMENT_ID}")  # unauthenticated, unknown path
    api.client.get(f"/{SENTINEL}", headers=headers)
    logged = "\n".join(
        r.getMessage() for r in caplog.records if r.name.startswith("voice_agent_api")
    )
    assert logged  # the application did log its outcome lines
    for forbidden in (SENTINEL, APPOINTMENT_ID, CLIENT_A, SECRET, "Bearer"):
        assert forbidden not in logged, forbidden


def test_the_layer_is_pure_asgi_and_logs_only_names(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO)

    async def app(scope: Any, receive: Any, send: Any) -> None:
        raise AssertionError("must not be reached")

    layer = ProtectionMiddleware(app, Protection(secret_digest(SECRET), None))

    async def run() -> list[MutableMapping[str, Any]]:
        sent: list[MutableMapping[str, Any]] = []

        async def receive() -> MutableMapping[str, Any]:
            return {"type": "http.disconnect"}

        async def send(message: MutableMapping[str, Any]) -> None:
            sent.append(message)

        await layer(
            {"type": "http", "method": "GET", "path": f"/{SENTINEL}", "headers": []}, receive, send
        )
        return sent

    sent = asyncio.run(run())
    assert sent[0]["status"] == 401
    assert all(SENTINEL not in r.getMessage() for r in caplog.records)
