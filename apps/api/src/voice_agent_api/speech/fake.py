"""A deterministic, scripted speech-to-text port for tests and offline development.

It makes no network request, reads no file and keeps no audio: it only counts calls and remembers
the size and type of the last clip. `SPEECH_PROVIDER=fake` selects it, and configuration refuses
that choice unless `APP_ENV` is explicitly `development` or `test`, so it cannot be enabled by
accident in a public deployment.
"""

import threading
import time
from typing import Literal

from voice_agent_api.speech.contracts import AudioClip, Transcript
from voice_agent_api.speech.errors import NoSpeech

# Fictional, and about the fictional shop: the demo never needs a real sentence.
DEFAULT_FAKE_TRANSCRIPT = "Do you have time for a flat repair on Tuesday?"

FakeOutcome = Literal["text", "no_speech", "error"]


class ScriptedSpeechToText:
    """Returns a fixed transcript, or raises, after an optional delay or until released.

    - `outcome="text"`: return `text`. `"no_speech"`: raise `NoSpeech`. `"error"`: raise an
      arbitrary exception (the service reduces it to a fixed `transcription_failed`).
    - `delay_s` sleeps first, and `release` blocks until the event is set: both make a call
      slower than the provider timeout, to exercise timeouts and abandonment.
    """

    def __init__(
        self,
        text: str = DEFAULT_FAKE_TRANSCRIPT,
        *,
        outcome: FakeOutcome = "text",
        delay_s: float = 0.0,
        release: threading.Event | None = None,
    ) -> None:
        self.text = text
        self.outcome = outcome
        self.delay_s = delay_s
        self.release = release
        self.calls = 0
        self.last_media_type: str | None = None
        self.last_size = 0

    def transcribe(self, clip: AudioClip) -> Transcript:
        self.calls += 1
        self.last_media_type = clip.media_type
        self.last_size = len(clip.data)
        if self.delay_s:
            time.sleep(self.delay_s)
        if self.release is not None and not self.release.wait(30):
            raise TimeoutError  # never leave a worker blocked forever
        if self.outcome == "no_speech":
            raise NoSpeech
        if self.outcome == "error":
            raise RuntimeError("scripted failure")
        return Transcript(self.text)
