from typing import Protocol

from voice_agent_api.speech.contracts import AudioClip, Transcript


class SpeechToText(Protocol):
    """Turns one short clip into text. Blocking: it is only ever called through
    `SpeechService`, never on the event loop.

    An adapter raises a `SpeechError` for an expected failure (for example `NoSpeech`). Any other
    exception is reduced to `TranscriptionFailed`, and its message is never used."""

    def transcribe(self, clip: AudioClip) -> Transcript: ...
