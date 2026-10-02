"""The speech-to-text factory and the Groq adapter.

This is the one module in `speech/` that knows a vendor: `groq` is imported inside the adapter's
constructor, so a disabled or fake provider never loads it. No model id is chosen here:
`SPEECH_MODEL` comes from settings (ADR 0009). The adapter makes no automatic retries, does not
stream, always asks for English, and never logs or returns anything the SDK produced: an SDK
exception is reduced to a fixed `SpeechError`, and only its class name and HTTP status are logged.
"""

import logging
import os
from typing import Any

from voice_agent_api.config import ConfigError, Settings
from voice_agent_api.speech.contracts import AudioClip, AudioMediaType, Transcript
from voice_agent_api.speech.errors import (
    AudioInvalid,
    AudioTooLarge,
    NoSpeech,
    SpeechError,
    TranscriptionFailed,
    TranscriptionTimeout,
)
from voice_agent_api.speech.fake import ScriptedSpeechToText
from voice_agent_api.speech.ports import SpeechToText

GROQ_BASE_URL = "https://api.groq.com"  # pinned: never taken from the environment
_TRACING_VARIABLES = (
    "LANGSMITH_TRACING",
    "LANGSMITH_TRACING_V2",
    "LANGCHAIN_TRACING_V2",
    "LANGCHAIN_TRACING",
)
_EXTENSIONS: dict[AudioMediaType, str] = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "mp4",
    "audio/wav": "wav",
}
logger = logging.getLogger("voice_agent_api")


def build_speech_to_text(
    settings: Settings, *, http_client: Any | None = None
) -> SpeechToText | None:
    """None when speech is disabled (the route then answers 503). `http_client` lets tests inject
    a transport so no request ever leaves the machine."""
    if settings.speech_provider == "disabled":
        return None
    if settings.speech_provider == "fake":
        if settings.app_env not in ("development", "test"):
            raise ConfigError  # validation rejects this earlier; fail closed regardless
        return ScriptedSpeechToText()
    if settings.speech_provider == "groq":
        return GroqSpeechToText(settings, http_client)
    raise ConfigError


def _refuse_tracing() -> None:
    """Tracing would send audio-derived text to a third party. A host that enables it (a stray
    environment variable) fails startup, naming only the variable."""
    for name in _TRACING_VARIABLES:
        if os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}:
            logger.error("Invalid server configuration: %s must not enable tracing", name)
            raise ConfigError


def _quiet_provider_loggers() -> None:
    """Pin the SDK's and the HTTP stack's loggers to WARNING, whatever the root logger is set to."""
    for name in ("groq", "httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)


def classify_provider_error(exc: BaseException) -> SpeechError:
    """A fixed error for an SDK failure. Only the exception's class names and its HTTP status are
    read, never its message (which can echo request content)."""
    status = getattr(exc, "status_code", None)
    if isinstance(exc, TimeoutError) or any("Timeout" in c.__name__ for c in type(exc).__mro__):
        return TranscriptionTimeout()
    if status == 413:
        return AudioTooLarge()
    if status in (400, 415, 422):
        return AudioInvalid()  # the provider could not decode what it was sent
    return TranscriptionFailed()  # auth, rate limit, 5xx, connection failure, anything else


class GroqSpeechToText:
    """`whisper` transcription through the installed `groq` SDK. Blocking: it is only called by
    `SpeechService`, in its own worker pool."""

    def __init__(self, settings: Settings, http_client: Any | None = None) -> None:
        _refuse_tracing()  # before the SDK is even imported
        import groq

        _quiet_provider_loggers()
        if settings.groq_api_key is None or not settings.speech_model:
            raise ConfigError  # validation rejects this earlier; fail closed regardless
        self._model = settings.speech_model
        self._client = groq.Groq(
            api_key=settings.groq_api_key.get_secret_value(),
            base_url=GROQ_BASE_URL,
            timeout=settings.speech_timeout_s,
            max_retries=0,
            http_client=http_client,
        )

    def transcribe(self, clip: AudioClip) -> Transcript:
        try:
            result = self._client.audio.transcriptions.create(
                file=(f"audio.{_EXTENSIONS[clip.media_type]}", clip.data, clip.media_type),
                model=self._model,
                language="en",
                response_format="json",
                temperature=0.0,
            )
        except Exception as exc:
            # Class name and status only: never the message, the body or the audio.
            logger.warning(
                "speech_provider_error error=%s status=%s",
                type(exc).__name__,
                getattr(exc, "status_code", "-"),
            )
            raise classify_provider_error(exc) from None
        text = getattr(result, "text", None)
        if not isinstance(text, str) or not text.strip():
            raise NoSpeech
        return Transcript(text)
