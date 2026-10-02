"""Content-Type normalization and container signatures.

What this proves, and what it does not. A signature recognises only the container family: the first
bytes of a WebM/Matroska, Ogg, MP4 or WAV file. It does not prove that the file holds playable
audio, that it is well formed, or how long it lasts. The server does not measure duration at all
(that would need ffmpeg, PyAV or fragile parsers, which this milestone does not add): the 15 s and
0.3 s limits are client-side, and the real duration is a documented residual risk until Milestone 5.
"""

from voice_agent_api.speech.contracts import AudioMediaType
from voice_agent_api.speech.errors import AudioUnsupported

_ALLOWED: dict[str, AudioMediaType] = {
    "audio/webm": "audio/webm",
    "audio/ogg": "audio/ogg",
    "audio/mp4": "audio/mp4",
    "audio/wav": "audio/wav",
}

_EBML = b"\x1a\x45\xdf\xa3"  # WebM and Matroska share this header; DocType is not inspected


def declared_media_type(content_type: str | None) -> AudioMediaType:
    """The allowed media type named by a Content-Type header. Parameters such as `;codecs=opus`
    are ignored. A missing header, or any other type, raises `AudioUnsupported`."""
    if content_type is None:
        raise AudioUnsupported
    essence = content_type.split(";", 1)[0].strip().lower()
    try:
        return _ALLOWED[essence]
    except KeyError:
        raise AudioUnsupported from None


def sniff_media_type(data: bytes) -> AudioMediaType | None:
    """The container family the first bytes show, or None."""
    if data.startswith(_EBML):
        return "audio/webm"
    if data.startswith(b"OggS"):
        return "audio/ogg"
    if len(data) >= 12 and data[0:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return "audio/mp4"
    return None


def require_signature(data: bytes, declared: AudioMediaType) -> None:
    """The signature must match the declared family, otherwise `AudioUnsupported`."""
    if sniff_media_type(data) != declared:
        raise AudioUnsupported
