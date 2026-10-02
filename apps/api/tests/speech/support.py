"""Helpers for the speech tests. Everything is synthetic: audio bytes are generated here, no human
voice is stored, and nothing leaves the machine."""

import asyncio
import io
import math
import struct
import threading
import time
import wave
from collections.abc import AsyncIterator, Callable, MutableMapping
from typing import Any

import httpx
from fastapi import FastAPI

from tests.support import NOW, make_world
from voice_agent_api.factory import create_app
from voice_agent_api.speech.bounded import SpeechService
from voice_agent_api.speech.contracts import AudioClip, AudioMediaType, Transcript
from voice_agent_api.speech.limits import SpeechLimits

URL = "/v1/speech/transcriptions"
KEY = bytes(range(32))


def wav_bytes(seconds: float = 0.05, rate: int = 16000) -> bytes:
    """A deterministic mono 16-bit sine tone, built in memory with the stdlib."""
    frames = b"".join(
        struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / rate)))
        for i in range(int(seconds * rate))
    )
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(frames)
    return buffer.getvalue()


# Minimal synthetic headers: enough for the container signature, and padded so they are not tiny.
# They are not playable audio, which is the point: the signature proves the family only.
WEBM = b"\x1a\x45\xdf\xa3" + b"\x93\x42\x82\x84webm" + bytes(64)
OGG = b"OggS\x00\x02" + bytes(64)
MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + bytes(64)
WAV = wav_bytes()

SAMPLES: dict[AudioMediaType, bytes] = {
    "audio/webm": WEBM,
    "audio/ogg": OGG,
    "audio/mp4": MP4,
    "audio/wav": WAV,
}


class ScriptedSpeech:
    """A scripted `SpeechToText` port. It can return text, raise, or block until released."""

    def __init__(
        self,
        text: str = "hello there",
        *,
        error: BaseException | None = None,
        block: threading.Event | None = None,
        sleep_s: float = 0.0,
    ) -> None:
        self.text = text
        self.error = error
        self.block = block
        self.sleep_s = sleep_s
        self.started = threading.Event()
        self.finished = threading.Event()
        self.clips: list[AudioClip] = []
        self.threads: set[int] = set()

    @property
    def calls(self) -> int:
        return len(self.clips)

    def transcribe(self, clip: AudioClip) -> Transcript:
        self.clips.append(clip)
        self.threads.add(threading.get_ident())
        self.started.set()
        try:
            if self.sleep_s:
                time.sleep(self.sleep_s)
            if self.block is not None:
                assert self.block.wait(10), "the test never released the port"
            if self.error is not None:
                raise self.error
            return Transcript(self.text)
        finally:
            self.finished.set()


def build_app(
    port: ScriptedSpeech | None, limits: SpeechLimits | None = None
) -> tuple[FastAPI, SpeechService | None]:
    catalog, book = make_world()
    service = SpeechService(port, limits) if port is not None else None
    app = create_app(catalog, book, lambda: NOW, signing_key=KEY, speech=service)
    return app, service


async def chunks(*parts: bytes) -> AsyncIterator[bytes]:
    for part in parts:
        yield part


class CountingStream:
    """An async byte stream that counts how many chunks were pulled from it."""

    def __init__(self, parts: list[bytes]) -> None:
        self.parts = parts
        self.pulled = 0

    def __aiter__(self) -> "CountingStream":
        return self

    async def __anext__(self) -> bytes:
        if self.pulled >= len(self.parts):
            raise StopAsyncIteration
        part = self.parts[self.pulled]
        self.pulled += 1
        return part


async def post(app: FastAPI, content: Any, headers: dict[str, str] | None = None) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post(URL, content=content, headers=headers or {})


def request(app: FastAPI, content: Any, headers: dict[str, str] | None = None) -> httpx.Response:
    return asyncio.run(post(app, content, headers))


def audio(media_type: AudioMediaType = "audio/wav") -> tuple[bytes, dict[str, str]]:
    return SAMPLES[media_type], {"content-type": media_type}


async def wait_until(condition: Callable[[], bool], timeout_s: float = 3.0) -> None:
    deadline = time.monotonic() + timeout_s
    while not condition():
        assert time.monotonic() < deadline, "condition not reached"
        await asyncio.sleep(0.01)


async def run_asgi(
    app: FastAPI,
    messages: list[dict[str, Any]],
    headers: dict[str, str],
) -> tuple[int, bytes]:
    """Call the app directly with a scripted ASGI receive channel (for a client disconnect)."""
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "path": URL,
        "raw_path": URL.encode(),
        "query_string": b"",
        "headers": [
            (name.lower().encode(), value.encode())
            for name, value in {"host": "test", **headers}.items()
        ],
        "client": ("127.0.0.1", 1),
        "server": ("test", 80),
        "scheme": "http",
    }
    queue = list(messages)
    sent: list[MutableMapping[str, Any]] = []

    async def receive() -> MutableMapping[str, Any]:
        if queue:
            return queue.pop(0)
        await asyncio.sleep(10)
        return {"type": "http.disconnect"}

    async def send(message: MutableMapping[str, Any]) -> None:
        sent.append(message)

    await app(scope, receive, send)
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, body
