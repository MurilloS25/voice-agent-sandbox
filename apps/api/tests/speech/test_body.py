import asyncio
from collections.abc import AsyncIterator

import pytest

from tests.speech.support import CountingStream, chunks
from voice_agent_api.speech import bounded
from voice_agent_api.speech.bounded import BodyAccumulator, read_audio
from voice_agent_api.speech.errors import AudioTooLarge, TranscriptionTimeout

LIMIT = 100


def test_the_accumulator_refuses_a_chunk_that_would_cross_the_limit() -> None:
    accumulator = BodyAccumulator(10)
    assert accumulator.add(b"x" * 11) is False  # a single chunk over the limit is never added
    assert len(accumulator) == 0
    assert accumulator.add(b"x" * 10) is True  # exactly the limit is allowed
    assert accumulator.add(b"y") is False
    assert len(accumulator) == 10
    assert accumulator.data() == b"x" * 10


def test_a_body_is_read_across_many_chunks() -> None:
    data = asyncio.run(read_audio(chunks(b"ab", b"", b"cd", b"e"), limit=LIMIT, timeout_s=1))
    assert data == b"abcde"


def test_a_body_of_exactly_the_limit_is_accepted() -> None:
    data = asyncio.run(read_audio(chunks(b"a" * 60, b"b" * 40), limit=LIMIT, timeout_s=1))
    assert len(data) == LIMIT


def test_an_empty_stream_gives_empty_bytes() -> None:
    assert asyncio.run(read_audio(chunks(), limit=LIMIT, timeout_s=1)) == b""


def test_the_chunk_that_crosses_the_limit_stops_the_stream_without_draining_it() -> None:
    stream = CountingStream([b"x" * 30] * 50)

    with pytest.raises(AudioTooLarge):
        asyncio.run(read_audio(stream, limit=LIMIT, timeout_s=1))

    assert stream.pulled == 4  # 30 + 30 + 30 fit; the fourth would make 120 and stops the read
    assert stream.pulled < 50


def test_a_single_chunk_over_the_limit_is_never_added_to_the_accumulator(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    peaks: list[int] = []

    class Spy(BodyAccumulator):
        def add(self, chunk: bytes) -> bool:
            added = super().add(chunk)
            peaks.append(len(self))
            return added

    monkeypatch.setattr(bounded, "BodyAccumulator", Spy)
    stream = CountingStream([b"x" * 10_000, b"y"])

    with pytest.raises(AudioTooLarge):
        asyncio.run(read_audio(stream, limit=LIMIT, timeout_s=1))

    assert peaks == [0]  # the oversized chunk never entered the buffer
    assert stream.pulled == 1  # and nothing more was read


def test_the_accumulator_never_exceeds_the_limit_whatever_the_chunk_sizes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    peaks: list[int] = []

    class Spy(BodyAccumulator):
        def add(self, chunk: bytes) -> bool:
            added = super().add(chunk)
            peaks.append(len(self))
            return added

    monkeypatch.setattr(bounded, "BodyAccumulator", Spy)
    sizes = [7, 33, 1, 59, 3, 90, 20]
    with pytest.raises(AudioTooLarge):
        asyncio.run(read_audio(chunks(*[b"z" * n for n in sizes]), limit=LIMIT, timeout_s=1))
    assert peaks and max(peaks) <= LIMIT


def test_a_stalled_read_times_out_and_closes_the_stream() -> None:
    closed: list[bool] = []

    async def stalled() -> AsyncIterator[bytes]:
        try:
            yield b"first"
            await asyncio.sleep(30)
            yield b"never"
        finally:
            closed.append(True)

    with pytest.raises(TranscriptionTimeout):
        asyncio.run(read_audio(stalled(), limit=LIMIT, timeout_s=0.1))
    assert closed == [True]


def test_the_stream_is_closed_after_an_oversized_body() -> None:
    closed: list[bool] = []

    async def source() -> AsyncIterator[bytes]:
        try:
            while True:
                yield b"x" * 60
        finally:
            closed.append(True)

    with pytest.raises(AudioTooLarge):
        asyncio.run(read_audio(source(), limit=LIMIT, timeout_s=1))
    assert closed == [True]
