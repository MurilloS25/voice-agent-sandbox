"""Bounded waits for blocking calls.

`BoundedCaller` stops *waiting* after a limit. It cannot cancel a blocking HTTP or database call:
an abandoned call keeps running in its worker until its own timeouts end it. That is safe because
callers pass a function that only returns a value; nothing an abandoned call returns is ever
applied to a conversation or a turn.
"""

import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass


class CallTimedOut(Exception):
    """The per-call limit elapsed before the call finished."""


class DeadlineExceeded(Exception):
    """The turn deadline ended the wait, or too little time was left to start the call."""


@dataclass(frozen=True)
class Deadline:
    expires_at: float
    clock: Callable[[], float] = time.monotonic

    @classmethod
    def after(cls, seconds: float, clock: Callable[[], float] = time.monotonic) -> "Deadline":
        return cls(clock() + seconds, clock)

    def remaining(self) -> float:
        return self.expires_at - self.clock()


class BoundedCaller:
    """Runs calls in a dedicated pool (default 8 workers), so abandoned calls cannot starve the
    FastAPI threadpool. If every worker is busy, a new call queues and its wait still ends at the
    limit, which degrades the turn."""

    def __init__(self, max_workers: int = 8) -> None:
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="agent")
        self.closed = False

    def call[T](
        self,
        fn: Callable[[], T],
        *,
        limit_s: float,
        deadline: Deadline,
        min_start_s: float,
    ) -> T:
        remaining = deadline.remaining()
        if remaining < min_start_s:
            raise DeadlineExceeded
        wait_s = min(limit_s, remaining)
        future = self._executor.submit(fn)
        done, _ = wait([future], timeout=wait_s)
        if not done:
            future.cancel()  # only effective while still queued
            raise DeadlineExceeded if remaining < limit_s else CallTimedOut
        return future.result()

    # `Lifecycle` (factory.py): the executor is created lazily, so open has nothing to do.
    def open(self) -> None:
        return None

    def close(self) -> None:
        """Stop accepting calls. Threads are not daemons, so a call still blocked at process exit
        can delay exit until its own provider or database timeout ends it."""
        self.closed = True
        self._executor.shutdown(wait=False, cancel_futures=True)
