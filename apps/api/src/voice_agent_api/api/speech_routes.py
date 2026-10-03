"""The speech route, the one `async def` route in the API.

It is async only because `request.stream()` is: the body is read incrementally, chunk by chunk,
and cut off as soon as it exceeds the byte limit. It never uses `UploadFile`, multipart,
`Request.body()` or a `bytes` body parameter, each of which would accumulate the body first (and
Starlette spools multipart files over 1 MB to disk). Nothing blocking runs here: the provider call
is handed to `SpeechService`, which runs it in its own bounded pool. This module is checked by
`tests/api/test_event_loop.py` to contain no blocking call.
"""

import logging
import re
import time
from typing import Annotated, Any

from fastapi import APIRouter, Header, Request
from pydantic import BeforeValidator, Field
from starlette.requests import ClientDisconnect

from voice_agent_api.api.dependencies import SpeechDep
from voice_agent_api.api.schemas import ErrorResponse
from voice_agent_api.speech.bounded import read_audio
from voice_agent_api.speech.contracts import (
    AudioClip,
    TranscriptionResponse,
    normalize_transcript,
)
from voice_agent_api.speech.errors import (
    AudioInvalid,
    AudioTooLarge,
    NoSpeech,
    SpeechError,
    SpeechUnavailable,
)
from voice_agent_api.speech.limits import MAX_DECLARED_DURATION_MS
from voice_agent_api.speech.sniff import declared_media_type, require_signature

router = APIRouter()
logger = logging.getLogger("voice_agent_api")

_DIGITS = re.compile(r"[0-9]{1,6}")


def _require_whole_number(value: object) -> object:
    if not isinstance(value, str) or not _DIGITS.fullmatch(value):
        raise ValueError("Expected a whole number of milliseconds.")
    return int(value)


def _declared_length_exceeds(value: str, limit: int) -> bool:
    """True only for a Content-Length that is a plain number above the limit. Anything unreadable
    is ignored (the counted bytes decide). The digit count is bounded before converting, because
    `int()` refuses very long digit strings and a crafted header must not become a 500."""
    if not (value.isascii() and value.isdigit()):
        return False
    significant = value.lstrip("0")
    return len(significant) > 15 or int(significant or "0") > limit


DeclaredDurationMs = Annotated[
    int, BeforeValidator(_require_whole_number), Field(ge=0, le=MAX_DECLARED_DURATION_MS)
]

_SPEECH_ERRORS: dict[int | str, dict[str, Any]] = {
    413: {"model": ErrorResponse, "description": "audio_too_large: more than 256 KB."},
    415: {
        "model": ErrorResponse,
        "description": "audio_unsupported: type not allowed, or the signature does not match it.",
    },
    422: {
        "model": ErrorResponse,
        "description": "audio_invalid, no_speech or validation_error.",
    },
    429: {
        "model": ErrorResponse,
        "description": "speech_busy: every transcription slot is taken.",
        "headers": {
            "Retry-After": {
                "description": "Seconds to wait before retrying.",
                "schema": {"type": "integer"},
            }
        },
    },
    502: {"model": ErrorResponse, "description": "transcription_failed."},
    503: {
        "model": ErrorResponse,
        "description": (
            "speech_unavailable (no provider is configured), demo_budget_reached, "
            "budget_unavailable or service_draining. The provider was not called."
        ),
    },
    504: {"model": ErrorResponse, "description": "transcription_timeout."},
}

# The body is raw audio, not a form or JSON, so FastAPI cannot derive it: describe it here.
_AUDIO_BODY: dict[str, Any] = {
    "requestBody": {
        "required": True,
        "description": "The raw audio bytes of one short recording (at most 256 KB).",
        "content": {
            media_type: {"schema": {"type": "string", "format": "binary"}}
            for media_type in ("audio/webm", "audio/ogg", "audio/mp4", "audio/wav")
        },
    }
}


@router.post(
    "/v1/speech/transcriptions",
    response_model=TranscriptionResponse,
    tags=["speech"],
    responses=_SPEECH_ERRORS,
    openapi_extra=_AUDIO_BODY,
)
async def create_transcription(
    request: Request,
    speech: SpeechDep,
    declared_duration_ms: Annotated[
        DeclaredDurationMs | None,
        Header(
            alias="X-Audio-Duration-Ms",
            description=(
                "What the client says the recording lasts. Not verified by the server: "
                "diagnostics only."
            ),
        ),
    ] = None,
) -> TranscriptionResponse:
    """Transcribe one short recording. It does not call the assistant and stores nothing."""
    started = time.monotonic()
    outcome = "error"
    size = 0
    try:
        # Checked before the body is touched, so a disabled feature never reads (or buffers) it.
        # FastAPI validates `X-Audio-Duration-Ms` earlier still: a malformed header is a 422
        # even when the feature is disabled.
        if speech is None:
            raise SpeechUnavailable
        media_type = declared_media_type(request.headers.get("content-type"))
        limit = speech.limits.max_audio_bytes

        # Content-Length can only reject early. It is never trusted to accept: the bytes are
        # counted as they arrive.
        if _declared_length_exceeds(request.headers.get("content-length", ""), limit):
            raise AudioTooLarge

        try:
            data = await read_audio(
                request.stream(), limit=limit, timeout_s=speech.limits.read_timeout_s
            )
        except ClientDisconnect:
            outcome = "client_disconnected"
            raise AudioInvalid from None
        size = len(data)
        if not data:
            raise AudioInvalid
        require_signature(data, media_type)

        clip = AudioClip(
            data=data, media_type=media_type, declared_duration_ms=declared_duration_ms
        )
        transcript = await speech.transcribe(clip)
        text = normalize_transcript(transcript.text)
        if text is None:
            raise NoSpeech
        outcome = "ok"
        return TranscriptionResponse(text=text, language="en")
    except SpeechError as exc:
        if outcome == "error":
            outcome = exc.code
        raise
    finally:
        # Counts and timings only: never audio, a transcript or a filename.
        logger.info(
            "speech_transcription outcome=%s bytes=%d declared_duration_ms=%s duration_ms=%d",
            outcome,
            size,
            declared_duration_ms if declared_duration_ms is not None else "-",
            int((time.monotonic() - started) * 1000),
        )
