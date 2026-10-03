"""Bounded reading of the request body and bounded execution of the blocking provider call.

Body. `read_audio` consumes an async byte stream chunk by chunk. Before a chunk is added it checks
`current size + len(chunk) <= limit`; a chunk that would cross the limit is never added, the stream
is not read any further and `AudioTooLarge` is raised. The guarantee is exactly this: **the
application accumulator never retains more than the configured limit.** It does not claim that an
ASGI server never hands over one transient chunk larger than the limit before the check runs.
Nothing is written to disk.

Execution. The provider call is blocking, so it never runs on the event loop. `SpeechService` owns
one dedicated, bounded pool (created once, closed with the app) and a slot counter of the same size.
A slot is taken before the call is submitted and given back only when the call itself ends, never
when the caller stops waiting: an abandoned call (deadline, client cancel) cannot be cancelled and
keeps its slot until it finishes, so at most `max_concurrent` calls can ever be alive. Nothing
reads an abandoned call's result: the worker returns a value (never raises), so a late result
touches no state and writes no log line.
"""

import asyncio
import logging
import threading
from collections.abc import AsyncGenerator, AsyncIterator
from concurrent.futures import Future, ThreadPoolExecutor

from starlette.concurrency import run_in_threadpool

from voice_agent_api.budget.guard import BudgetGuard, Reservation
from voice_agent_api.speech.contracts import AudioClip, Transcript
from voice_agent_api.speech.errors import (
    AudioInvalid,
    AudioTooLarge,
    AudioUnsupported,
    NoSpeech,
    SpeechBusy,
    SpeechError,
    SpeechUnavailable,
    TranscriptionFailed,
    TranscriptionTimeout,
)
from voice_agent_api.speech.limits import SpeechLimits
from voice_agent_api.speech.ports import SpeechToText

logger = logging.getLogger("voice_agent_api")

# The only error classes an adapter may raise on purpose. They are re-created from scratch so the
# message is always the fixed one, whatever an adapter put in its own.
_PUBLIC_ERRORS: tuple[type[SpeechError], ...] = (
    AudioInvalid,
    AudioTooLarge,
    AudioUnsupported,
    NoSpeech,
    SpeechUnavailable,
    TranscriptionFailed,
    TranscriptionTimeout,
)


class BodyAccumulator:
    """Holds the bytes read so far and refuses any chunk that would make it exceed `limit`."""

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._buffer = bytearray()

    def __len__(self) -> int:
        return len(self._buffer)

    def add(self, chunk: bytes) -> bool:
        """False, and nothing added, when the chunk would cross the limit."""
        if len(self._buffer) + len(chunk) > self._limit:
            return False
        self._buffer += chunk
        return True

    def data(self) -> bytes:
        return bytes(self._buffer)


async def read_audio(stream: AsyncIterator[bytes], *, limit: int, timeout_s: float) -> bytes:
    """The whole body, within `limit` bytes and `timeout_s` seconds.

    `AudioTooLarge` when a chunk would cross the limit (the stream is closed, not drained);
    `TranscriptionTimeout` when the read takes too long. A disconnect raises the server's own
    exception, which the caller handles. An empty body is returned as empty bytes."""
    accumulator = BodyAccumulator(limit)
    try:
        async with asyncio.timeout(timeout_s):
            async for chunk in stream:
                if chunk and not accumulator.add(chunk):
                    raise AudioTooLarge
    except TimeoutError:
        raise TranscriptionTimeout from None
    finally:
        # Stop the producer instead of leaving it suspended with unread data behind it.
        if isinstance(stream, AsyncGenerator):
            await stream.aclose()
    return accumulator.data()


class _Slots:
    """A counter of calls in flight (abandoned ones included)."""

    def __init__(self, size: int) -> None:
        self._size = size
        self._used = 0
        self._lock = threading.Lock()

    def try_acquire(self) -> bool:
        with self._lock:
            if self._used >= self._size:
                return False
            self._used += 1
            return True

    def release(self) -> None:
        with self._lock:
            self._used -= 1

    @property
    def in_flight(self) -> int:
        with self._lock:
            return self._used


class SpeechService:
    """Runs a `SpeechToText` port off the event loop with a slot limit and a deadline."""

    def __init__(
        self,
        port: SpeechToText,
        limits: SpeechLimits | None = None,
        budget: BudgetGuard | None = None,
    ) -> None:
        self.limits = limits or SpeechLimits()
        self._budget = budget
        self._port = port
        self._slots = _Slots(self.limits.max_concurrent)
        # As many workers as slots: an admitted call never queues behind an abandoned one.
        self._executor = ThreadPoolExecutor(
            max_workers=self.limits.max_concurrent, thread_name_prefix="speech"
        )
        self._closed = False

    @property
    def in_flight(self) -> int:
        return self._slots.in_flight

    async def transcribe(self, clip: AudioClip) -> Transcript:
        """Raises `SpeechBusy` (no free slot), `TranscriptionTimeout` (the wait ended; the call is
        abandoned and keeps its slot until it finishes) or the fixed error the port raised."""
        if self._closed:
            raise SpeechUnavailable
        if not self._slots.try_acquire():
            raise SpeechBusy
        reservation: Reservation | None = None
        if self._budget is not None:
            # Seconds are reserved before the provider is contacted (a blocking database call,
            # so off the event loop). A refusal frees the slot and costs nothing.
            try:
                reservation = await run_in_threadpool(self._budget.reserve_speech, len(clip.data))
            except BaseException:
                self._slots.release()
                raise
        try:
            future = self._executor.submit(self._run, clip)
        except RuntimeError:  # the pool was shut down: the provider was never contacted
            self._slots.release()
            if self._budget is not None and reservation is not None:
                await run_in_threadpool(self._budget.refund, reservation)
            raise SpeechUnavailable from None
        future.add_done_callback(self._release)

        waiter = asyncio.wrap_future(future)
        try:
            done, _ = await asyncio.wait({waiter}, timeout=self.limits.provider_timeout_s)
            if not done:
                raise TranscriptionTimeout
            if waiter.cancelled():  # `close()` cancelled a call that had not started
                raise SpeechUnavailable
            outcome = waiter.result()
        finally:
            if not waiter.done():
                # Detaches this request from the call. A running call is not cancelled; it ends on
                # its own, frees its slot, and its result is dropped unread.
                waiter.cancel()
        if isinstance(outcome, SpeechError):
            raise outcome
        return outcome

    def _release(self, _: "Future[Transcript | SpeechError]") -> None:
        self._slots.release()

    def _run(self, clip: AudioClip) -> Transcript | SpeechError:
        """Runs in a worker. Returns a value whatever the port does, so an abandoned call has
        nothing to log or re-raise; it logs only an exception's class name."""
        try:
            return self._port.transcribe(clip)
        except SpeechError as exc:
            for known in _PUBLIC_ERRORS:
                if type(exc) is known:
                    return known()
            return TranscriptionFailed()
        except BaseException as exc:
            logger.warning("speech_provider_error error=%s", type(exc).__name__)
            return TranscriptionFailed()

    # `Lifecycle` (factory.py)
    def open(self) -> None:
        return None

    def close(self) -> None:
        """Stop accepting calls. Threads are not daemons, so a call still blocked at process exit
        can delay exit until the provider's own timeout ends it."""
        self._closed = True
        self._executor.shutdown(wait=False, cancel_futures=True)
