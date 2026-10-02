"""Typed audio and transcript contracts.

`AudioClip` and `Transcript` hide their payload from `repr`, so audio bytes and transcribed text
cannot reach a log line or a traceback by accident.
"""

import re
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

MAX_TRANSCRIPT_CHARS = 500  # the same limit the agent accepts for a message

# The container families the API accepts. The value is the canonical media type.
AudioMediaType = Literal["audio/webm", "audio/ogg", "audio/mp4", "audio/wav"]

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


@dataclass(frozen=True, slots=True)
class AudioClip:
    """One recording, in memory only. `declared_duration_ms` is what the client claimed: it is
    never measured by the server and is for diagnostics only."""

    data: bytes = field(repr=False)
    media_type: AudioMediaType
    declared_duration_ms: int | None = None


@dataclass(frozen=True, slots=True)
class Transcript:
    text: str = field(repr=False)


class TranscriptionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    text: str = Field(
        min_length=1,
        max_length=MAX_TRANSCRIPT_CHARS,
        description="Machine-transcribed text. The visitor can edit it before sending it.",
    )
    language: Literal["en"] = Field(description="Transcription is English only for now.")


def normalize_transcript(text: str) -> str | None:
    """One line, no control characters, at most 500 characters. None when nothing is left."""
    cleaned = " ".join(_CONTROL.sub(" ", text).split())
    return cleaned[:MAX_TRANSCRIPT_CHARS].rstrip() or None
