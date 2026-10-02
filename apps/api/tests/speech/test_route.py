import asyncio
import json
import logging
import tempfile
import threading
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from tests.speech.support import (
    SAMPLES,
    URL,
    WAV,
    WEBM,
    CountingStream,
    ScriptedSpeech,
    audio,
    build_app,
    chunks,
    request,
    run_asgi,
    wait_until,
)
from voice_agent_api.speech.contracts import AudioMediaType
from voice_agent_api.speech.limits import SpeechLimits

LIMIT = SpeechLimits().max_audio_bytes
WAV_HEADERS = {"content-type": "audio/wav"}


def error_code(response: httpx.Response) -> str:
    return str(response.json()["error"]["code"])


# --- availability and the happy path ---------------------------------------------------------


def test_without_a_provider_the_route_answers_speech_unavailable_without_reading_the_body() -> None:
    app, _ = build_app(None)
    stream = CountingStream([WAV, b"x" * 100])

    response = request(app, stream, WAV_HEADERS)

    assert response.status_code == 503
    assert error_code(response) == "speech_unavailable"
    assert stream.pulled == 0  # a disabled feature does not even look at the audio


@pytest.mark.parametrize("media_type", list(SAMPLES))
def test_a_valid_clip_is_transcribed(media_type: AudioMediaType) -> None:
    port = ScriptedSpeech("Hello there")
    app, service = build_app(port)
    data, headers = audio(media_type)

    try:
        response = request(app, data, headers)
    finally:
        assert service is not None
        service.close()

    assert response.status_code == 200
    assert response.json() == {"text": "Hello there", "language": "en"}
    assert port.calls == 1
    clip = port.clips[0]
    assert clip.data == data and clip.media_type == media_type
    assert clip.declared_duration_ms is None


@pytest.mark.parametrize(
    ("spoken", "status", "expected"),
    [
        ("  Book   a\n flat repair \x00 ", 200, "Book a flat repair"),
        ("   \n ", 422, None),
    ],
)
def test_the_transcript_is_normalized_and_an_empty_one_is_no_speech(
    spoken: str, status: int, expected: str | None
) -> None:
    app, service = build_app(ScriptedSpeech(spoken))
    try:
        response = request(app, WAV, WAV_HEADERS)
    finally:
        assert service is not None
        service.close()
    assert response.status_code == status
    if expected is None:
        assert error_code(response) == "no_speech"
    else:
        assert response.json()["text"] == expected


# --- the body --------------------------------------------------------------------------------


def test_an_empty_body_is_audio_invalid() -> None:
    port = ScriptedSpeech()
    app, service = build_app(port)
    try:
        response = request(app, b"", WAV_HEADERS)
    finally:
        assert service is not None
        service.close()
    assert response.status_code == 422 and error_code(response) == "audio_invalid"
    assert port.calls == 0


def test_a_body_in_many_chunks_is_reassembled() -> None:
    port = ScriptedSpeech()
    app, service = build_app(port)
    try:
        response = request(app, chunks(WAV[:10], WAV[10:500], b"", WAV[500:]), WAV_HEADERS)
    finally:
        assert service is not None
        service.close()
    assert response.status_code == 200
    assert port.clips[0].data == WAV


def test_a_body_of_exactly_the_limit_is_accepted_and_one_byte_more_is_not() -> None:
    port = ScriptedSpeech()
    app, service = build_app(port)
    exact = WAV + bytes(LIMIT - len(WAV))
    try:
        ok = request(app, chunks(exact[:100_000], exact[100_000:]), WAV_HEADERS)
        too_big = request(app, chunks(exact[:100_000], exact[100_000:], b"\x00"), WAV_HEADERS)
    finally:
        assert service is not None
        service.close()
    assert ok.status_code == 200 and len(port.clips[0].data) == LIMIT
    assert too_big.status_code == 413 and error_code(too_big) == "audio_too_large"
    assert port.calls == 1


def test_the_chunk_that_crosses_the_limit_answers_413_and_the_stream_is_not_drained() -> None:
    port = ScriptedSpeech()
    app, service = build_app(port)
    stream = CountingStream([WAV, *[b"x" * 65_536] * 40])
    try:
        response = request(app, stream, WAV_HEADERS)
    finally:
        assert service is not None
        service.close()
    assert response.status_code == 413 and error_code(response) == "audio_too_large"
    assert stream.pulled <= 10  # it stopped at the crossing chunk instead of reading all 41
    assert port.calls == 0


def test_a_single_chunk_over_the_limit_answers_413() -> None:
    port = ScriptedSpeech()
    app, service = build_app(port)
    stream = CountingStream([WAV + bytes(LIMIT), b"more"])
    try:
        response = request(app, stream, WAV_HEADERS)
    finally:
        assert service is not None
        service.close()
    assert response.status_code == 413
    assert stream.pulled == 1
    assert port.calls == 0


def test_content_length_is_present_absent_or_false_but_only_the_counted_bytes_decide() -> None:
    port = ScriptedSpeech()
    app, service = build_app(port)
    try:
        true_length = request(app, WAV, WAV_HEADERS)  # httpx sets the real Content-Length
        absent = request(app, chunks(WAV), WAV_HEADERS)  # chunked: no Content-Length at all
        # A header that lies low does not let an oversized body through: bytes are counted.
        lies_low = request(
            app,
            CountingStream([b"x" * 65_536] * 12),
            {**WAV_HEADERS, "content-length": "10"},
        )
        # A header that is evidently too large is refused before any byte is read.
        huge = CountingStream([WAV])
        declared_huge = request(app, huge, {**WAV_HEADERS, "content-length": str(LIMIT + 1)})
        garbage = request(app, chunks(WAV), {**WAV_HEADERS, "content-length": "abc"})
    finally:
        assert service is not None
        service.close()

    assert true_length.status_code == 200
    assert absent.status_code == 200
    assert lies_low.status_code == 413 and error_code(lies_low) == "audio_too_large"
    assert declared_huge.status_code == 413 and huge.pulled == 0
    assert garbage.status_code == 200  # an unreadable header is ignored, never trusted
    assert port.calls == 3


def test_a_stalled_upload_times_out_and_the_port_is_not_called() -> None:
    port = ScriptedSpeech()
    app, service = build_app(port, SpeechLimits(read_timeout_s=0.2))

    async def stalled() -> AsyncIterator[bytes]:
        yield WAV[:100]
        await asyncio.sleep(30)
        yield WAV[100:]

    try:
        response = request(app, stalled(), WAV_HEADERS)
    finally:
        assert service is not None
        service.close()
    assert response.status_code == 504 and error_code(response) == "transcription_timeout"
    assert port.calls == 0


def test_a_client_that_disconnects_mid_upload_never_reaches_the_port(
    caplog: pytest.LogCaptureFixture,
) -> None:
    port = ScriptedSpeech()
    app, service = build_app(port)
    caplog.set_level(logging.INFO)
    messages: list[dict[str, Any]] = [
        {"type": "http.request", "body": WAV[:100], "more_body": True},
        {"type": "http.disconnect"},
    ]
    try:
        status, _ = asyncio.run(run_asgi(app, messages, WAV_HEADERS))
    finally:
        assert service is not None
        service.close()
    assert status == 422  # nobody is listening, but the handler still ends in a fixed error
    assert port.calls == 0
    assert "outcome=client_disconnected" in caplog.text


# --- Content-Type and signatures --------------------------------------------------------------


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"content-type": ""},
        {"content-type": "application/json"},
        {"content-type": "application/octet-stream"},
        {"content-type": "audio/mpeg"},
        {"content-type": "multipart/form-data; boundary=x"},
    ],
)
def test_a_missing_or_disallowed_content_type_is_unsupported(headers: dict[str, str]) -> None:
    port = ScriptedSpeech()
    app, service = build_app(port)
    try:
        response = request(app, WAV, headers)
    finally:
        assert service is not None
        service.close()
    assert response.status_code == 415 and error_code(response) == "audio_unsupported"
    assert port.calls == 0


@pytest.mark.parametrize(
    "content_type",
    ["audio/webm;codecs=opus", "audio/webm; codecs=opus", "AUDIO/WEBM ; Codecs=Opus"],
)
def test_content_type_parameters_do_not_change_the_family(content_type: str) -> None:
    port = ScriptedSpeech()
    app, service = build_app(port)
    try:
        response = request(app, WEBM, {"content-type": content_type})
    finally:
        assert service is not None
        service.close()
    assert response.status_code == 200
    assert port.clips[0].media_type == "audio/webm"


@pytest.mark.parametrize("declared", list(SAMPLES))
@pytest.mark.parametrize("actual", [*SAMPLES, "garbage", "short"])
def test_the_signature_must_match_the_declared_family(declared: str, actual: str) -> None:
    candidates: dict[str, bytes] = dict(SAMPLES.items())
    candidates["garbage"] = b"this is not audio" * 20
    candidates["short"] = b"RIFF"
    data = candidates[actual]
    port = ScriptedSpeech()
    app, service = build_app(port)
    try:
        response = request(app, data, {"content-type": declared})
    finally:
        assert service is not None
        service.close()
    if actual == declared:
        assert response.status_code == 200
    else:
        assert response.status_code == 415 and error_code(response) == "audio_unsupported"
        assert port.calls == 0


# --- X-Audio-Duration-Ms (untrusted, diagnostic) ---------------------------------------------


def test_a_declared_duration_is_passed_on_as_declared_and_logged_as_such(
    caplog: pytest.LogCaptureFixture,
) -> None:
    port = ScriptedSpeech()
    app, service = build_app(port)
    caplog.set_level(logging.INFO)
    try:
        with_header = request(app, WAV, {**WAV_HEADERS, "x-audio-duration-ms": "1500"})
        without = request(app, WAV, WAV_HEADERS)
        at_max = request(app, WAV, {**WAV_HEADERS, "x-audio-duration-ms": "60000"})
    finally:
        assert service is not None
        service.close()
    assert [r.status_code for r in (with_header, without, at_max)] == [200, 200, 200]
    assert [c.declared_duration_ms for c in port.clips] == [1500, None, 60000]
    assert "declared_duration_ms=1500" in caplog.text
    assert "declared_duration_ms=-" in caplog.text


@pytest.mark.parametrize("value", ["abc", "-1", "1.5", "", "1e3", "60001", "9999999", "0x10"])
def test_a_malformed_declared_duration_is_a_validation_error(value: str) -> None:
    port = ScriptedSpeech()
    app, service = build_app(port)
    try:
        response = request(app, WAV, {**WAV_HEADERS, "x-audio-duration-ms": value})
    finally:
        assert service is not None
        service.close()
    assert response.status_code == 422 and error_code(response) == "validation_error"
    assert port.calls == 0
    if value:
        assert value not in response.text  # the submitted value is not echoed back


# --- concurrency, deadline, late results -----------------------------------------------------


def test_a_full_service_answers_429_with_retry_after() -> None:
    release = threading.Event()
    port = ScriptedSpeech(block=release)
    app, service = build_app(port, SpeechLimits(max_concurrent=1))

    async def run() -> tuple[httpx.Response, httpx.Response]:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            first = asyncio.create_task(client.post(URL, content=WAV, headers=WAV_HEADERS))
            await wait_until(port.started.is_set)
            busy = await client.post(URL, content=WAV, headers=WAV_HEADERS)
            release.set()
            return busy, await first

    try:
        busy, first = asyncio.run(run())
    finally:
        release.set()
        assert service is not None
        service.close()
    assert busy.status_code == 429 and error_code(busy) == "speech_busy"
    assert busy.headers["retry-after"] == "2"
    assert first.status_code == 200
    assert port.calls == 1


def test_work_over_the_deadline_answers_504_and_the_late_result_is_dropped(
    caplog: pytest.LogCaptureFixture,
) -> None:
    release = threading.Event()
    port = ScriptedSpeech("LATE-RESULT-TEXT", block=release)
    app, service = build_app(port, SpeechLimits(provider_timeout_s=0.2, max_concurrent=1))
    caplog.set_level(logging.DEBUG)

    async def run() -> list[httpx.Response]:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            assert service is not None
            late = await client.post(URL, content=WAV, headers=WAV_HEADERS)
            still_busy = await client.post(URL, content=WAV, headers=WAV_HEADERS)
            assert service.in_flight == 1  # the abandoned call still holds its slot

            release.set()
            await wait_until(port.finished.is_set)
            await wait_until(lambda: service.in_flight == 0)
            port.block, port.text = None, "fresh"
            after = await client.post(URL, content=WAV, headers=WAV_HEADERS)
            return [late, still_busy, after]

    try:
        late, still_busy, after = asyncio.run(run())
    finally:
        release.set()
        assert service is not None
        service.close()
    assert late.status_code == 504 and error_code(late) == "transcription_timeout"
    assert still_busy.status_code == 429
    assert after.status_code == 200 and after.json()["text"] == "fresh"
    assert "LATE-RESULT-TEXT" not in caplog.text
    assert "LATE-RESULT-TEXT" not in late.text + still_busy.text + after.text


def test_the_event_loop_keeps_responding_while_the_port_blocks() -> None:
    port = ScriptedSpeech(sleep_s=0.3)  # a blocking call, like a provider SDK
    app, service = build_app(port, SpeechLimits(max_concurrent=2))

    async def run() -> tuple[float, float, float]:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            loop = asyncio.get_running_loop()
            lags: list[float] = []
            stop = asyncio.Event()

            async def sampler() -> None:
                previous = loop.time()
                while not stop.is_set():
                    await asyncio.sleep(0.01)
                    now = loop.time()
                    lags.append(now - previous - 0.01)
                    previous = now

            task = asyncio.create_task(sampler())
            await asyncio.sleep(0.05)
            started = time.perf_counter()
            posts = [
                asyncio.create_task(client.post(URL, content=WAV, headers=WAV_HEADERS))
                for _ in range(2)
            ]
            await wait_until(lambda: port.calls == 2)
            probe = time.perf_counter()
            assert (await client.get("/health")).status_code == 200
            health_latency = time.perf_counter() - probe
            results = await asyncio.gather(*posts)
            elapsed = time.perf_counter() - started
            stop.set()
            await task
            assert [r.status_code for r in results] == [200, 200]
            return elapsed, health_latency, max(lags)

    try:
        elapsed, health_latency, max_lag = asyncio.run(run())
    finally:
        assert service is not None
        service.close()
    assert elapsed < 0.55, f"two 0.3 s calls took {elapsed:.2f}s: they were serialized"
    assert health_latency < 0.1, f"/health took {health_latency:.3f}s during a transcription"
    assert max_lag < 0.1, f"the event loop stalled for {max_lag:.3f}s"


# --- privacy and safety ----------------------------------------------------------------------


def test_no_temporary_file_is_ever_created(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("a temporary file was requested")

    for name in (
        "SpooledTemporaryFile",
        "TemporaryFile",
        "NamedTemporaryFile",
        "TemporaryDirectory",
        "mkstemp",
        "mkdtemp",
    ):
        monkeypatch.setattr(tempfile, name, forbidden)

    port = ScriptedSpeech()
    app, service = build_app(port)
    big = chunks(WAV, *[b"x" * 65_536] * 20)  # over 1 MB, where multipart would spool to disk
    try:
        ok = request(app, WAV, WAV_HEADERS)
        too_big = request(app, big, WAV_HEADERS)
    finally:
        assert service is not None
        service.close()
    assert ok.status_code == 200 and too_big.status_code == 413


def test_audio_and_transcripts_never_appear_in_logs(caplog: pytest.LogCaptureFixture) -> None:
    port = ScriptedSpeech("PRIVATE WORDS SPOKEN")
    app, service = build_app(port)
    caplog.set_level(logging.DEBUG)
    try:
        ok = request(app, WAV, WAV_HEADERS)
        bad = request(app, WAV, {"content-type": "audio/ogg"})
    finally:
        assert service is not None
        service.close()
    assert ok.status_code == 200 and bad.status_code == 415
    assert "PRIVATE WORDS" not in caplog.text
    assert "RIFF" not in caplog.text and "WAVE" not in caplog.text
    assert "speech_transcription outcome=ok" in caplog.text
    assert f"bytes={len(WAV)}" in caplog.text
    assert "speech_transcription outcome=audio_unsupported" in caplog.text


@pytest.mark.parametrize(
    "error",
    [
        RuntimeError("SECRET-PROVIDER-BODY api_key=gsk_FAKE"),
        KeyError("SECRET-PROVIDER-BODY"),
        ConnectionError("SECRET-PROVIDER-BODY"),
    ],
)
def test_public_errors_never_contain_internal_exceptions(
    error: BaseException, caplog: pytest.LogCaptureFixture
) -> None:
    port = ScriptedSpeech(error=error)
    app, service = build_app(port)
    caplog.set_level(logging.DEBUG)
    try:
        response = request(app, WAV, WAV_HEADERS)
    finally:
        assert service is not None
        service.close()
    assert response.status_code == 502
    body = response.json()
    assert body["error"]["code"] == "transcription_failed"
    assert "SECRET" not in response.text and "gsk_" not in response.text
    assert "Traceback" not in response.text
    assert "SECRET" not in caplog.text and "gsk_" not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_every_public_error_matches_its_class_code_and_status() -> None:
    from voice_agent_api.api.errors import _DOMAIN_ERRORS
    from voice_agent_api.speech import errors

    classes = [
        c
        for c in vars(errors).values()
        if isinstance(c, type) and issubclass(c, errors.SpeechError) and c is not errors.SpeechError
    ]
    assert len(classes) == 8
    for error_class in classes:
        status, code = _DOMAIN_ERRORS[error_class]
        assert code == error_class.code
        assert status in {413, 415, 422, 429, 502, 503, 504}
        assert "\n" not in str(error_class())  # fixed one-line message


def test_the_lifespan_closes_the_speech_service() -> None:
    port = ScriptedSpeech()
    app, service = build_app(port)
    assert service is not None

    async def run() -> None:
        async with app.router.lifespan_context(app):
            pass

    asyncio.run(run())
    response = request(app, WAV, WAV_HEADERS)
    assert response.status_code == 503 and error_code(response) == "speech_unavailable"
    assert port.calls == 0


def test_the_openapi_contract_describes_a_raw_audio_body_and_no_multipart() -> None:
    app, _ = build_app(None)
    schema = app.openapi()
    operation = schema["paths"][URL]["post"]

    assert set(operation["requestBody"]["content"]) == set(SAMPLES)
    assert "multipart/form-data" not in json.dumps(schema)
    assert set(operation["responses"]) == {
        "200",
        "413",
        "415",
        "422",
        "429",
        "502",
        "503",
        "504",
    }
    assert "Retry-After" in operation["responses"]["429"]["headers"]
    names = {p["name"] for p in operation["parameters"]}
    assert names == {"X-Audio-Duration-Ms"}


@pytest.mark.parametrize("digits", ["9" * 16, "9" * 5000, "0" * 5000 + "1"])
def test_a_crafted_content_length_never_becomes_a_server_error(digits: str) -> None:
    port = ScriptedSpeech()
    app, service = build_app(port)
    stream = CountingStream([WAV])
    try:
        response = request(app, stream, {**WAV_HEADERS, "content-length": digits})
    finally:
        assert service is not None
        service.close()
    if digits.startswith("0"):  # leading zeros: the value is 1, so the real bytes decide
        assert response.status_code == 200
    else:
        assert response.status_code == 413 and stream.pulled == 0


def test_a_malformed_duration_header_is_a_422_even_when_the_feature_is_disabled() -> None:
    app, _ = build_app(None)
    stream = CountingStream([WAV])
    response = request(app, stream, {**WAV_HEADERS, "x-audio-duration-ms": "abc"})
    assert response.status_code == 422 and error_code(response) == "validation_error"
    assert stream.pulled == 0  # the body is still never read


class Boom(BaseException):
    """Not an `Exception`: it must still not escape the worker or reach the client."""


def test_a_non_exception_failure_in_the_port_is_a_fixed_502(
    caplog: pytest.LogCaptureFixture,
) -> None:
    port = ScriptedSpeech(error=Boom("SECRET-PROVIDER-BODY"))
    app, service = build_app(port)
    caplog.set_level(logging.DEBUG)
    try:
        response = request(app, WAV, WAV_HEADERS)
    finally:
        assert service is not None
        service.close()
    assert response.status_code == 502 and error_code(response) == "transcription_failed"
    assert "SECRET" not in response.text and "SECRET" not in caplog.text
