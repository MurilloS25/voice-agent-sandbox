"""Budgets for one transcription request (plan 0004, "Limits" and "Timeout budget").

The server enforces only what it can enforce: the byte limit, the container family, concurrency and
time. It does not verify the real duration of the audio (see `sniff.py` and the plan).

Worst case from route entry to response is `read_timeout_s + provider_timeout_s` = 9 s with the
defaults. The web client allows that bound plus `WEB_MARGIN_S` (14 s): that is
`SPEECH_TIMEOUT_MS` in `apps/web/src/lib/api/client.ts`, and `tests/speech/test_budget.py` pins the
two sides together.
"""

from dataclasses import dataclass

from voice_agent_api.config import Settings

WEB_MARGIN_S = 5.0  # the same margin as booking requests and agent turns
MAX_DECLARED_DURATION_MS = 60_000


@dataclass(frozen=True)
class SpeechLimits:
    max_audio_bytes: int = 256 * 1024
    read_timeout_s: float = 3.0  # the whole request body
    provider_timeout_s: float = 6.0  # the wait for the transcription call
    max_concurrent: int = 2  # transcriptions in flight, abandoned ones included

    @classmethod
    def from_settings(cls, settings: Settings) -> "SpeechLimits":
        return cls(
            max_audio_bytes=settings.speech_max_audio_bytes,
            read_timeout_s=settings.speech_read_timeout_s,
            provider_timeout_s=settings.speech_timeout_s,
            max_concurrent=settings.speech_max_concurrent,
        )

    @property
    def server_bound_s(self) -> float:
        return self.read_timeout_s + self.provider_timeout_s

    @property
    def web_timeout_s(self) -> float:
        return self.server_bound_s + WEB_MARGIN_S
