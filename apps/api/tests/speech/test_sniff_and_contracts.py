import pytest

from tests.speech.support import MP4, OGG, SAMPLES, WAV, WEBM
from voice_agent_api.speech.contracts import (
    MAX_TRANSCRIPT_CHARS,
    AudioClip,
    AudioMediaType,
    Transcript,
    normalize_transcript,
)
from voice_agent_api.speech.errors import AudioUnsupported
from voice_agent_api.speech.sniff import declared_media_type, require_signature, sniff_media_type


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("audio/webm", "audio/webm"),
        ("audio/webm;codecs=opus", "audio/webm"),
        ("audio/webm; codecs=opus", "audio/webm"),
        ("Audio/WebM ; Codecs=opus", "audio/webm"),
        ("audio/ogg;codecs=opus", "audio/ogg"),
        ("audio/mp4;codecs=mp4a.40.2", "audio/mp4"),
        ("audio/wav", "audio/wav"),
        ("  audio/wav  ", "audio/wav"),
    ],
)
def test_parameters_are_ignored_when_choosing_the_family(header: str, expected: str) -> None:
    assert declared_media_type(header) == expected


@pytest.mark.parametrize(
    "header",
    [
        None,
        "",
        "application/json",
        "application/octet-stream",
        "audio/mpeg",
        "audio/x-wav",
        "audio/webmx",
        "video/webm",
        "multipart/form-data; boundary=x",
        "text/plain",
    ],
)
def test_other_types_are_rejected(header: str | None) -> None:
    with pytest.raises(AudioUnsupported):
        declared_media_type(header)


@pytest.mark.parametrize("media_type", list(SAMPLES))
def test_each_allowed_signature_is_recognised_as_its_own_family(media_type: AudioMediaType) -> None:
    assert sniff_media_type(SAMPLES[media_type]) == media_type
    require_signature(SAMPLES[media_type], media_type)


@pytest.mark.parametrize("declared", list(SAMPLES))
@pytest.mark.parametrize("data", [WEBM, OGG, MP4, WAV, b"not audio at all", b"RIFF", b"", b"\x00"])
def test_a_signature_that_does_not_match_the_declared_family_is_rejected(
    declared: AudioMediaType, data: bytes
) -> None:
    if sniff_media_type(data) == declared:
        require_signature(data, declared)
        return
    with pytest.raises(AudioUnsupported):
        require_signature(data, declared)


def test_riff_that_is_not_wave_and_a_short_header_are_not_recognised() -> None:
    assert sniff_media_type(b"RIFF\x00\x00\x00\x00AVI LIST") is None
    assert sniff_media_type(b"\x00\x00\x00\x18ftyp") is None  # shorter than 12 bytes


def test_audio_and_transcripts_are_hidden_from_repr() -> None:
    clip = AudioClip(data=b"SECRET-AUDIO-BYTES", media_type="audio/wav", declared_duration_ms=900)
    assert "SECRET" not in repr(clip)
    assert "900" in repr(clip)
    assert "secret words" not in repr(Transcript("secret words"))


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("  hello   there \n friend ", "hello there friend"),
        ("tab\tand\x00null\x07bell", "tab and null bell"),
        ("   \n\t ", None),
        ("", None),
        ("\x00\x01", None),
    ],
)
def test_transcripts_are_one_clean_line(raw: str, expected: str | None) -> None:
    assert normalize_transcript(raw) == expected


def test_transcripts_are_cut_to_the_message_limit() -> None:
    text = normalize_transcript("word " * 400)
    assert text is not None
    assert len(text) <= MAX_TRANSCRIPT_CHARS
    assert not text.endswith(" ")
