import threading

import pytest

from tests.speech.support import audio, build_app, request
from voice_agent_api.speech.bounded import SpeechService
from voice_agent_api.speech.contracts import AudioClip
from voice_agent_api.speech.errors import NoSpeech
from voice_agent_api.speech.fake import DEFAULT_FAKE_TRANSCRIPT, ScriptedSpeechToText

CLIP = AudioClip(data=b"RIFF....WAVE", media_type="audio/wav")


def test_the_fake_is_deterministic_and_keeps_no_audio() -> None:
    fake = ScriptedSpeechToText()
    assert fake.transcribe(CLIP).text == DEFAULT_FAKE_TRANSCRIPT
    assert fake.transcribe(CLIP).text == DEFAULT_FAKE_TRANSCRIPT
    assert (fake.calls, fake.last_media_type, fake.last_size) == (2, "audio/wav", len(CLIP.data))
    assert not any(isinstance(v, bytes) for v in vars(fake).values())  # no clip is retained


def test_the_fake_can_return_other_text_no_speech_or_an_error() -> None:
    assert ScriptedSpeechToText("hello").transcribe(CLIP).text == "hello"
    with pytest.raises(NoSpeech):
        ScriptedSpeechToText(outcome="no_speech").transcribe(CLIP)
    with pytest.raises(RuntimeError):
        ScriptedSpeechToText(outcome="error").transcribe(CLIP)


def test_the_fake_can_block_until_released() -> None:
    release = threading.Event()
    fake = ScriptedSpeechToText(release=release)
    done = threading.Event()

    def run() -> None:
        fake.transcribe(CLIP)
        done.set()

    thread = threading.Thread(target=run)
    thread.start()
    assert not done.wait(0.1)  # still blocked
    release.set()
    thread.join(5)
    assert done.is_set()


def test_the_fake_works_behind_the_route_without_files_or_network() -> None:
    service = SpeechService(ScriptedSpeechToText("Book me a tune-up"))
    app, _ = build_app(None)
    app.state.speech = service
    data, headers = audio("audio/wav")
    try:
        response = request(app, data, headers)
    finally:
        service.close()
    assert response.status_code == 200
    assert response.json() == {"text": "Book me a tune-up", "language": "en"}
