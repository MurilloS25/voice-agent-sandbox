"""Helpers for the trust-boundary tests: the real app with the protection layer on."""

from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient

from tests.agent.support import KEY, AgentWorld, say
from tests.speech.support import ScriptedSpeech
from tests.support import NOW, id_sequence
from voice_agent_api.factory import create_app
from voice_agent_api.security.auth import secret_digest
from voice_agent_api.security.middleware import Protection
from voice_agent_api.security.ratelimit import (
    Category,
    CategoryLimits,
    Policy,
    RateLimits,
)
from voice_agent_api.speech.bounded import SpeechService
from voice_agent_api.speech.limits import SpeechLimits

SECRET = "unit-test-shared-secret-0123456789-abcdefghij"
AUTH = {"Authorization": f"Bearer {SECRET}"}
CLIENT_A = "a" * 32
CLIENT_B = "b" * 32


class Clock:
    """A manual monotonic clock, so no test sleeps."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def limits(
    clock: Callable[[], float],
    *,
    agent: tuple[int, int] = (6, 3),
    speech: tuple[int, int] = (6, 6),
    write: tuple[int, int] = (6, 12),
    read: tuple[int, int] = (60, 300),
    max_clients: int = 5000,
) -> RateLimits:
    def pair(values: tuple[int, int]) -> CategoryLimits:
        return CategoryLimits(Policy.per_minute(values[0]), Policy.per_minute(values[1]))

    return RateLimits(
        {
            Category.AGENT: pair(agent),
            Category.SPEECH: pair(speech),
            Category.WRITE: pair(write),
            Category.READ: pair(read),
        },
        clock,
        max_clients=max_clients,
    )


class Protected:
    """The app with authentication and rate limits, a scripted model and a scripted speech port."""

    def __init__(
        self,
        *,
        clock: Clock | None = None,
        rate_limits: RateLimits | None = None,
        auth: bool = True,
        docs_enabled: bool = False,
        ready_check: Callable[[], bool] | None = None,
        json_body_limit: int = 16 * 1024,
        steps: list[Any] | None = None,
        log_tracebacks: bool = False,
        speech_limits: SpeechLimits | None = None,
    ) -> None:
        self.clock = clock or Clock()
        self.world = AgentWorld(steps if steps is not None else [say("ok")] * 50)
        self.speech_port = ScriptedSpeech()
        self.speech = SpeechService(self.speech_port, speech_limits or SpeechLimits())
        self.rate_limits = rate_limits if rate_limits is not None else limits(self.clock)
        self.protection = Protection(
            secret_digest=secret_digest(SECRET) if auth else None,
            limits=self.rate_limits,
            json_body_limit=json_body_limit,
            json_read_timeout_s=0.5,
        )
        self.app = create_app(
            self.world.catalog,
            self.world.book,
            lambda: NOW,
            signing_key=KEY,
            id_factory=id_sequence(),
            agent=self.world.service,
            speech=self.speech,
            protection=self.protection,
            docs_enabled=docs_enabled,
            ready_check=ready_check,
            log_tracebacks=log_tracebacks,
        )
        self.client = TestClient(self.app, raise_server_exceptions=False)

    def turn(self, message: str = "hello", *, index: int = 1, client: str = CLIENT_A) -> Any:
        from uuid import uuid4

        return self.client.post(
            "/v1/agent/turns",
            headers={**AUTH, "X-Client-Id": client},
            json={
                "conversation_id": str(self.world.conversation_id),
                "client_turn_id": str(uuid4()),
                "turn_index": index,
                "message": message,
            },
        )
