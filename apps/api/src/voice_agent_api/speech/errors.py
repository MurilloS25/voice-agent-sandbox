"""Typed speech errors. Messages are fixed strings that never carry audio, a transcript, a submitted
value or an exception's text. Each class has the public `code` the API returns for it."""

from voice_agent_api.domain.errors import DomainError


class SpeechError(DomainError):
    """Base of the expected speech failures. A provider adapter raises one of these (or lets any
    other exception escape, which the service reduces to `TranscriptionFailed`)."""

    code = "speech_error"


class SpeechUnavailable(SpeechError):
    code = "speech_unavailable"

    def __init__(self) -> None:
        super().__init__("Voice input is not available. You can still type your message.")


class AudioTooLarge(SpeechError):
    code = "audio_too_large"

    def __init__(self) -> None:
        super().__init__("That recording is too large. Record a shorter message.")


class AudioUnsupported(SpeechError):
    code = "audio_unsupported"

    def __init__(self) -> None:
        super().__init__("That audio format is not supported.")


class AudioInvalid(SpeechError):
    code = "audio_invalid"

    def __init__(self) -> None:
        super().__init__("That recording could not be read. Try recording again.")


class NoSpeech(SpeechError):
    code = "no_speech"

    def __init__(self) -> None:
        super().__init__("No speech was found in that recording. Try again or type your message.")


class SpeechBusy(SpeechError):
    code = "speech_busy"
    retry_after_s = 2

    def __init__(self) -> None:
        super().__init__("Voice input is busy. Try again in a moment.")


class TranscriptionFailed(SpeechError):
    code = "transcription_failed"

    def __init__(self) -> None:
        super().__init__("The recording could not be transcribed. Try again or type your message.")


class TranscriptionTimeout(SpeechError):
    code = "transcription_timeout"

    def __init__(self) -> None:
        super().__init__("Transcription took too long. Try again or type your message.")
