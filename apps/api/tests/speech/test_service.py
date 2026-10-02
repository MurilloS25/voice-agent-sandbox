import asyncio
import logging
import threading

import pytest

from tests.speech.support import ScriptedSpeech, wait_until
from voice_agent_api.speech.bounded import SpeechService
from voice_agent_api.speech.contracts import AudioClip
from voice_agent_api.speech.errors import (
    AudioInvalid,
    NoSpeech,
    SpeechBusy,
    SpeechError,
    SpeechUnavailable,
    TranscriptionFailed,
    TranscriptionTimeout,
)
from voice_agent_api.speech.limits import SpeechLimits

CLIP = AudioClip(data=b"RIFF....WAVE", media_type="audio/wav")
FAST = SpeechLimits(provider_timeout_s=0.2, max_concurrent=1)


def test_a_call_runs_in_a_worker_thread_not_on_the_event_loop() -> None:
    port = ScriptedSpeech("hi")
    service = SpeechService(port)

    async def run() -> int:
        loop_thread = threading.get_ident()
        transcript = await service.transcribe(CLIP)
        assert transcript.text == "hi"
        return loop_thread

    try:
        loop_thread = asyncio.run(run())
    finally:
        service.close()
    assert port.threads and loop_thread not in port.threads


def test_a_slot_is_held_while_a_call_runs_and_freed_when_it_ends() -> None:
    release = threading.Event()
    port = ScriptedSpeech(block=release)
    service = SpeechService(port, FAST)

    async def run() -> None:
        task = asyncio.create_task(service.transcribe(CLIP))
        await wait_until(port.started.is_set)
        assert service.in_flight == 1
        release.set()
        await task
        await wait_until(lambda: service.in_flight == 0)

    try:
        asyncio.run(run())
    finally:
        service.close()


def test_a_full_service_answers_busy_without_calling_the_port() -> None:
    release = threading.Event()
    port = ScriptedSpeech(block=release)
    service = SpeechService(port, SpeechLimits(max_concurrent=2))

    async def run() -> None:
        first = asyncio.create_task(service.transcribe(CLIP))
        second = asyncio.create_task(service.transcribe(CLIP))
        await wait_until(lambda: service.in_flight == 2)
        with pytest.raises(SpeechBusy):
            await service.transcribe(CLIP)
        assert port.calls == 2
        release.set()
        await asyncio.gather(first, second)

    try:
        asyncio.run(run())
    finally:
        release.set()
        service.close()


def test_an_abandoned_call_keeps_its_slot_until_it_finishes_and_its_result_is_dropped(
    caplog: pytest.LogCaptureFixture,
) -> None:
    release = threading.Event()
    port = ScriptedSpeech("LATE-RESULT-TEXT", block=release)
    service = SpeechService(port, FAST)
    caplog.set_level(logging.DEBUG)

    async def run() -> None:
        with pytest.raises(TranscriptionTimeout):
            await service.transcribe(CLIP)  # the wait ends after 0.2 s
        assert service.in_flight == 1  # the call itself is still running
        with pytest.raises(SpeechBusy):
            await service.transcribe(CLIP)  # so nobody can take its slot
        assert port.calls == 1

        release.set()  # the late call now finishes
        await wait_until(lambda: service.in_flight == 0)
        assert port.finished.is_set()

        port.block, port.text = None, "fresh"  # the slot is free again for a new call
        assert (await service.transcribe(CLIP)).text == "fresh"

    try:
        asyncio.run(run())
    finally:
        release.set()
        service.close()
    assert "LATE-RESULT-TEXT" not in caplog.text  # a late result writes nothing


def test_a_cancelled_request_does_not_free_the_slot_of_a_running_call() -> None:
    release = threading.Event()
    port = ScriptedSpeech(block=release)
    service = SpeechService(port, SpeechLimits(max_concurrent=1))

    async def run() -> None:
        task = asyncio.create_task(service.transcribe(CLIP))
        await wait_until(port.started.is_set)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert service.in_flight == 1
        release.set()
        await wait_until(lambda: service.in_flight == 0)

    try:
        asyncio.run(run())
    finally:
        release.set()
        service.close()


@pytest.mark.parametrize("error_type", [AudioInvalid, NoSpeech, TranscriptionFailed])
def test_a_fixed_error_from_the_port_is_passed_on(error_type: type[SpeechError]) -> None:
    service = SpeechService(ScriptedSpeech(error=error_type()))
    try:
        with pytest.raises(error_type):
            asyncio.run(service.transcribe(CLIP))
    finally:
        service.close()


class Leaky(NoSpeech):
    """An adapter's own subclass that tries to put content in the public message."""

    def __init__(self) -> None:
        SpeechError.__init__(self, "LEAKED-TRANSCRIPT")


@pytest.mark.parametrize(
    "error",
    [
        RuntimeError("SECRET-PROVIDER-BODY"),
        ValueError("SECRET-PROVIDER-BODY"),
        SpeechError("SECRET-PROVIDER-BODY"),
        Leaky(),
        ConnectionError("SECRET-PROVIDER-BODY"),
    ],
)
def test_anything_else_becomes_a_fixed_transcription_failure_and_logs_only_a_class_name(
    error: BaseException, caplog: pytest.LogCaptureFixture
) -> None:
    service = SpeechService(ScriptedSpeech(error=error))
    caplog.set_level(logging.DEBUG)
    try:
        with pytest.raises(TranscriptionFailed) as raised:
            asyncio.run(service.transcribe(CLIP))
    finally:
        service.close()
    assert "SECRET" not in str(raised.value) and "LEAKED" not in str(raised.value)
    assert "SECRET" not in caplog.text and "LEAKED" not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_a_closed_service_is_unavailable_and_takes_no_slot() -> None:
    port = ScriptedSpeech()
    service = SpeechService(port)
    service.close()
    with pytest.raises(SpeechUnavailable):
        asyncio.run(service.transcribe(CLIP))
    assert port.calls == 0 and service.in_flight == 0


def test_one_pool_is_reused_for_every_call() -> None:
    port = ScriptedSpeech()
    service = SpeechService(port, SpeechLimits(max_concurrent=2))

    async def run() -> None:
        for _ in range(6):
            await service.transcribe(CLIP)

    try:
        asyncio.run(run())
    finally:
        service.close()
    assert len(port.threads) <= 2  # a pool of two workers, not a new executor per call
