"""The Groq adapter, offline: the real `groq` SDK over an injected mock HTTP transport.

No request leaves the machine (`offline_guard` also blocks non-loopback sockets). The key is a
made-up string, and the replies are canned.
"""

import logging
from typing import Any

import httpx
import pytest
from pydantic import SecretStr

from tests.speech.support import MP4, OGG, WAV, WEBM, audio, build_app, request
from voice_agent_api.agent import providers as agent_providers
from voice_agent_api.config import ConfigError, Settings
from voice_agent_api.speech import providers
from voice_agent_api.speech.bounded import SpeechService
from voice_agent_api.speech.contracts import AudioClip, AudioMediaType
from voice_agent_api.speech.errors import (
    AudioInvalid,
    AudioTooLarge,
    NoSpeech,
    SpeechError,
    TranscriptionFailed,
    TranscriptionTimeout,
)
from voice_agent_api.speech.providers import GroqSpeechToText, build_speech_to_text

FAKE_KEY = "fake-offline-credential-for-tests-0001"
MODEL = "some/whisper-model"
SECRET_BODY = "SECRET-PROVIDER-DETAIL-4417"


def settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "speech_provider": "groq",
        "groq_api_key": SecretStr(FAKE_KEY),
        "speech_model": MODEL,
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


class Transport:
    """A scripted HTTP server: each reply is a status and a JSON body, or an exception."""

    def __init__(self, *replies: tuple[int, dict[str, Any]] | Exception) -> None:
        self._replies = list(replies)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        reply = self._replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        status, body = reply
        return httpx.Response(status, json=body)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self))


def adapter(transport: Transport, **overrides: Any) -> GroqSpeechToText:
    port = build_speech_to_text(settings(**overrides), http_client=transport.client())
    assert isinstance(port, GroqSpeechToText)
    return port


def clip(media_type: AudioMediaType = "audio/wav", data: bytes = WAV) -> AudioClip:
    return AudioClip(data=data, media_type=media_type, declared_duration_ms=1200)


# -- the request ---------------------------------------------------------------------------------


def test_the_request_goes_to_the_pinned_endpoint_with_the_expected_form() -> None:
    transport = Transport((200, {"text": "hello there"}))
    assert adapter(transport).transcribe(clip()).text == "hello there"

    assert len(transport.requests) == 1
    sent = transport.requests[0]
    assert sent.method == "POST"
    assert str(sent.url) == "https://api.groq.com/openai/v1/audio/transcriptions"
    assert sent.headers["content-type"].startswith("multipart/form-data")
    body = sent.content
    assert f'name="model"\r\n\r\n{MODEL}\r\n'.encode() in body
    assert b'name="language"\r\n\r\nen\r\n' in body
    assert b'name="response_format"\r\n\r\njson\r\n' in body
    assert b'filename="audio.wav"' in body and b"Content-Type: audio/wav" in body
    assert b"stream" not in body  # no streaming
    assert WAV in body  # the audio itself is what is sent


@pytest.mark.parametrize(
    ("media_type", "data", "extension"),
    [
        ("audio/webm", WEBM, "webm"),
        ("audio/ogg", OGG, "ogg"),
        ("audio/mp4", MP4, "mp4"),
        ("audio/wav", WAV, "wav"),
    ],
)
def test_the_file_name_and_type_follow_the_clip(
    media_type: AudioMediaType, data: bytes, extension: str
) -> None:
    transport = Transport((200, {"text": "ok"}))
    adapter(transport).transcribe(clip(media_type, data))
    assert f'filename="audio.{extension}"'.encode() in transport.requests[0].content


def test_the_client_has_no_retries_and_the_configured_timeout() -> None:
    port = adapter(Transport(), speech_timeout_s=4.5)
    assert port._client.max_retries == 0
    assert port._client.timeout == 4.5
    assert str(port._client.base_url).rstrip("/") == "https://api.groq.com"


def test_the_endpoint_cannot_be_redirected_by_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GROQ_BASE_URL", "https://evil.example.invalid")
    transport = Transport((200, {"text": "ok"}))
    adapter(transport).transcribe(clip())
    assert transport.requests[0].url.host == "api.groq.com"


def test_the_key_appears_only_in_the_authorization_header(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    transport = Transport((200, {"text": "hello"}))
    result = adapter(transport).transcribe(clip())

    sent = transport.requests[0]
    assert sent.headers["authorization"] == f"Bearer {FAKE_KEY}"
    for name, value in sent.headers.items():
        if name.lower() != "authorization":
            assert FAKE_KEY not in value, name
    assert FAKE_KEY not in str(sent.url)
    assert FAKE_KEY.encode() not in sent.content
    assert FAKE_KEY not in repr(result) and FAKE_KEY not in caplog.text


# -- results and errors --------------------------------------------------------------------------


@pytest.mark.parametrize("reply", [{"text": ""}, {"text": "   \n"}])
def test_an_empty_transcript_is_no_speech(reply: dict[str, Any]) -> None:
    with pytest.raises(NoSpeech):
        adapter(Transport((200, reply))).transcribe(clip())


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (400, AudioInvalid),
        (415, AudioInvalid),
        (422, AudioInvalid),
        (413, AudioTooLarge),
        (401, TranscriptionFailed),
        (403, TranscriptionFailed),
        (429, TranscriptionFailed),
        (500, TranscriptionFailed),
        (503, TranscriptionFailed),
    ],
)
def test_http_errors_become_fixed_errors_with_one_request_and_no_leak(
    status: int, expected: type[SpeechError], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    transport = Transport((status, {"error": {"message": SECRET_BODY}}), (200, {"text": "late"}))

    with pytest.raises(expected) as raised:
        adapter(transport).transcribe(clip())

    assert len(transport.requests) == 1  # max_retries=0: a 429 or 5xx costs exactly one request
    assert SECRET_BODY not in str(raised.value) and FAKE_KEY not in str(raised.value)
    assert raised.value.__cause__ is None
    assert SECRET_BODY not in caplog.text and FAKE_KEY not in caplog.text
    assert f"status={status}" in caplog.text  # only the class name and status are logged
    assert all(record.exc_info is None for record in caplog.records)


def test_timeouts_and_connection_failures_are_fixed_errors(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    with pytest.raises(TranscriptionTimeout):
        adapter(Transport(httpx.ReadTimeout(SECRET_BODY))).transcribe(clip())
    with pytest.raises(TranscriptionFailed):
        adapter(Transport(httpx.ConnectError(SECRET_BODY))).transcribe(clip())
    assert SECRET_BODY not in caplog.text


def test_classification_reads_only_class_names_and_status_never_the_message() -> None:
    class Weird(Exception):
        status_code = 429

    assert isinstance(providers.classify_provider_error(Weird(SECRET_BODY)), TranscriptionFailed)
    assert isinstance(
        providers.classify_provider_error(TimeoutError(SECRET_BODY)), TranscriptionTimeout
    )


def test_the_route_returns_the_transcript_and_never_the_key_or_provider_text(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    transport = Transport(
        (200, {"text": "Do you open on Saturdays"}), (500, {"error": SECRET_BODY})
    )
    service = SpeechService(adapter(transport))
    app, _ = build_app(None)
    app.state.speech = service
    data, headers = audio("audio/wav")
    try:
        ok = request(app, data, headers)
        failed = request(app, data, headers)
    finally:
        service.close()
    assert ok.status_code == 200 and ok.json()["text"] == "Do you open on Saturdays"
    assert failed.status_code == 502 and failed.json()["error"]["code"] == "transcription_failed"
    for text in (ok.text, failed.text, caplog.text):
        assert FAKE_KEY not in text and SECRET_BODY not in text
    assert "Do you open on Saturdays" not in caplog.text  # the transcript is never logged


# -- construction --------------------------------------------------------------------------------


def test_disabled_builds_nothing() -> None:
    assert build_speech_to_text(Settings(_env_file=None)) is None


@pytest.mark.parametrize(
    "name",
    ["LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING"],
)
def test_tracing_is_refused_naming_only_the_variable(
    monkeypatch: pytest.MonkeyPatch, name: str, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv(name, "true")
    with pytest.raises(ConfigError):
        build_speech_to_text(settings(), http_client=Transport().client())
    assert name in caplog.text and FAKE_KEY not in caplog.text


def test_the_tracing_variables_match_the_agents() -> None:
    assert providers._TRACING_VARIABLES == agent_providers._TRACING_VARIABLES


def test_provider_loggers_are_pinned_to_warning() -> None:
    for name in ("groq", "httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.DEBUG)
    adapter(Transport())
    for name in ("groq", "httpx", "httpcore"):
        assert logging.getLogger(name).level == logging.WARNING


def test_a_groq_adapter_without_a_key_or_model_fails_closed_even_if_validation_is_skipped() -> None:
    with pytest.raises(ConfigError):
        GroqSpeechToText(Settings(_env_file=None, speech_provider="groq", speech_model=MODEL))
    with pytest.raises(ConfigError):
        GroqSpeechToText(
            Settings(_env_file=None, speech_provider="groq", groq_api_key=SecretStr(FAKE_KEY))
        )
