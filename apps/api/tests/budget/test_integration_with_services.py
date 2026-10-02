"""The budget inside the agent and the speech service: reserved before the provider is called."""

import asyncio
import contextlib
from datetime import UTC, date, datetime
from uuid import uuid4

from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from tests.agent.support import KEY, AgentWorld, say
from tests.security.support import AUTH
from tests.speech.support import ScriptedSpeech, audio
from tests.support import NOW, id_sequence
from voice_agent_api.budget.errors import BudgetExhausted
from voice_agent_api.budget.guard import BudgetGuard
from voice_agent_api.budget.ledger import BudgetCategory, InMemoryBudgetLedger
from voice_agent_api.factory import create_app
from voice_agent_api.speech.bounded import SpeechService
from voice_agent_api.speech.contracts import AudioClip
from voice_agent_api.speech.errors import SpeechUnavailable

DAY = date(2026, 10, 6)
CLOCK = lambda: datetime(2026, 10, 6, 12, 0, tzinfo=UTC)  # noqa: E731


def guard(
    ledger: InMemoryBudgetLedger, *, tokens: int = 10_000, reserve: int = 400, seconds: int = 100
) -> BudgetGuard:
    return BudgetGuard(
        ledger,
        CLOCK,
        agent_daily_tokens=tokens,
        agent_turn_reserve=reserve,
        speech_daily_seconds=seconds,
        speech_min_billed_seconds=10,
        speech_min_bytes_per_second=3000,
    )


def used(ledger: InMemoryBudgetLedger, category: BudgetCategory) -> int:
    return ledger.used(DAY, category)


def usage(message: str, tokens_in: int, tokens_out: int) -> AIMessage:
    return AIMessage(
        content=message,
        usage_metadata={
            "input_tokens": tokens_in,
            "output_tokens": tokens_out,
            "total_tokens": tokens_in + tokens_out,
        },
    )


# --- the agent -----------------------------------------------------------------------------------


def test_a_turn_reserves_before_the_model_and_settles_to_the_real_usage() -> None:
    ledger = InMemoryBudgetLedger()
    seen: list[int] = []

    def step(_: object) -> AIMessage:
        seen.append(used(ledger, BudgetCategory.AGENT_TOKENS))  # while the model "runs"
        return usage("hello", 120, 30)

    world = AgentWorld([step], budget=guard(ledger))
    world.send("hi")
    assert seen == [400]  # the reservation was already in place
    assert used(ledger, BudgetCategory.AGENT_TOKENS) == 150  # settled to the real 120 + 30


def test_an_exhausted_budget_refuses_before_the_model_is_called_and_the_turn_can_be_retried() -> (
    None
):
    ledger = InMemoryBudgetLedger()
    world = AgentWorld([say("never")], budget=guard(ledger, tokens=300, reserve=400))
    request = world.request("hi")
    try:
        world.service.handle_turn(request)
        raise AssertionError("expected a refusal")
    except BudgetExhausted:
        pass
    assert len(world.model.calls) == 0
    assert used(ledger, BudgetCategory.AGENT_TOKENS) == 0
    # The turn marker was released: the same request is accepted again once money is available.
    other = AgentWorld([say("ok")], budget=guard(ledger, tokens=300, reserve=100))
    assert other.service.handle_turn(other.request("hi")).outcome == "completed"


def test_a_replayed_turn_costs_nothing_and_is_not_reserved_again() -> None:
    ledger = InMemoryBudgetLedger()
    world = AgentWorld([usage("first", 100, 20)], budget=guard(ledger))
    request = world.request("hi")
    world.service.handle_turn(request)
    after_first = used(ledger, BudgetCategory.AGENT_TOKENS)
    world.service.handle_turn(request)  # the identical retry: the stored answer, no model
    assert used(ledger, BudgetCategory.AGENT_TOKENS) == after_first == 120


def test_a_turn_that_ends_before_any_model_call_gives_the_reservation_back() -> None:
    from tests.agent.support import FailingCatalog
    from voice_agent_api.domain.errors import StorageUnavailable

    ledger = InMemoryBudgetLedger()
    failing = FailingCatalog(None)
    world = AgentWorld([say("never")], wrap_catalog=lambda inner: failing, budget=guard(ledger))
    failing.inner = world.catalog.inner if hasattr(world.catalog, "inner") else world.catalog
    failing.fail = StorageUnavailable()
    response = world.send("hi")
    assert response.outcome == "degraded"
    assert len(world.model.calls) == 0
    assert used(ledger, BudgetCategory.AGENT_TOKENS) == 0


def test_a_provider_failure_keeps_the_reservation_because_the_provider_may_have_counted_it() -> (
    None
):
    ledger = InMemoryBudgetLedger()
    world = AgentWorld([RuntimeError("provider down")], budget=guard(ledger))
    assert world.send("hi").outcome == "degraded"
    assert len(world.model.calls) == 1
    assert used(ledger, BudgetCategory.AGENT_TOKENS) == 400


def test_a_turn_without_reported_usage_keeps_its_reservation() -> None:
    ledger = InMemoryBudgetLedger()
    world = AgentWorld([say("no usage metadata")], budget=guard(ledger))
    world.send("hi")
    assert used(ledger, BudgetCategory.AGENT_TOKENS) == 400


def test_a_ledger_that_cannot_be_reached_refuses_the_turn_without_calling_the_model() -> None:
    class Down:
        def reserve(self, *_: object) -> bool:
            raise RuntimeError("db")

        def adjust(self, *_: object) -> None:
            raise RuntimeError("db")

    world = AgentWorld(
        [say("never")],
        budget=BudgetGuard(
            Down(),
            CLOCK,
            agent_daily_tokens=10,
            agent_turn_reserve=5,
            speech_daily_seconds=10,
            speech_min_billed_seconds=10,
            speech_min_bytes_per_second=3000,
        ),
    )
    from voice_agent_api.budget.errors import BudgetUnavailable

    try:
        world.service.handle_turn(world.request("hi"))
        raise AssertionError("expected a refusal")
    except BudgetUnavailable:
        pass
    assert len(world.model.calls) == 0


def test_tools_in_one_turn_are_counted_once_per_turn_not_per_call() -> None:
    ledger = InMemoryBudgetLedger()
    world = AgentWorld(
        [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "find_available_slots",
                        "args": {"service_id": "flat-repair", "date": "2026-10-06"},
                        "id": "c1",
                        "type": "tool_call",
                    }
                ],
                usage_metadata={"input_tokens": 200, "output_tokens": 20, "total_tokens": 220},
            ),
            usage("done", 300, 40),
        ],
        budget=guard(ledger),
    )
    world.send("times?")
    assert used(ledger, BudgetCategory.AGENT_TOKENS) == 560  # both calls, settled together


# --- the API surface -----------------------------------------------------------------------------


def api(ledger: InMemoryBudgetLedger, **kwargs: int) -> tuple[TestClient, AgentWorld]:
    from tests.security.support import SECRET, Clock, limits
    from voice_agent_api.security.auth import secret_digest
    from voice_agent_api.security.middleware import Protection

    world = AgentWorld([say("ok")] * 20, budget=guard(ledger, **kwargs))
    clock = Clock()
    app = create_app(
        world.catalog,
        world.book,
        lambda: NOW,
        signing_key=KEY,
        id_factory=id_sequence(),
        agent=world.service,
        protection=Protection(secret_digest(SECRET), limits(clock)),
    )
    return TestClient(app, raise_server_exceptions=False), world


def test_a_spent_budget_is_a_controlled_503_with_a_fixed_message() -> None:
    ledger = InMemoryBudgetLedger()
    client, world = api(ledger, tokens=100, reserve=400)
    response = client.post(
        "/v1/agent/turns",
        headers=AUTH,
        json={
            "conversation_id": str(world.conversation_id),
            "client_turn_id": str(uuid4()),
            "turn_index": 1,
            "message": "hello",
        },
    )
    assert response.status_code == 503
    assert response.json() == {
        "error": {
            "code": "demo_budget_reached",
            "message": "The demo has reached its daily limit. Please try again tomorrow.",
        }
    }
    assert "Retry-After" not in response.headers
    assert len(world.model.calls) == 0


# --- speech ---


def speech_service(
    ledger: InMemoryBudgetLedger, seconds: int = 100
) -> tuple[SpeechService, ScriptedSpeech]:
    port = ScriptedSpeech()
    return SpeechService(port, budget=guard(ledger, seconds=seconds)), port


def clip(size: int = 2000) -> AudioClip:
    return AudioClip(data=b"x" * size, media_type="audio/wav")


def test_speech_reserves_seconds_before_the_provider_is_called() -> None:
    ledger = InMemoryBudgetLedger()
    service, port = speech_service(ledger)

    async def run() -> None:
        await service.transcribe(clip(60_000))

    asyncio.run(run())
    assert port.calls == 1
    assert used(ledger, BudgetCategory.SPEECH_SECONDS) == 20  # worst case 60,000 B / 3,000 B/s


def test_an_exhausted_speech_budget_never_reaches_the_provider_and_frees_the_slot() -> None:
    ledger = InMemoryBudgetLedger()
    service, port = speech_service(ledger, seconds=15)

    async def run() -> None:
        await service.transcribe(clip(100))  # 10 s
        for _ in range(5):
            try:
                await service.transcribe(clip(100))
                raise AssertionError("expected a refusal")
            except BudgetExhausted:
                pass
        assert service.in_flight == 0  # the slot was freed each time

    asyncio.run(run())
    assert port.calls == 1


def test_a_closed_speech_service_gives_the_reservation_back() -> None:
    ledger = InMemoryBudgetLedger()
    service, port = speech_service(ledger)
    service.close()

    async def run() -> None:
        with contextlib.suppress(SpeechUnavailable):
            await service.transcribe(clip())

    asyncio.run(run())
    assert port.calls == 0
    assert used(ledger, BudgetCategory.SPEECH_SECONDS) == 0


def test_the_speech_route_answers_a_spent_budget_with_the_same_controlled_503() -> None:
    from tests.security.support import SECRET, Clock, limits
    from voice_agent_api.security.auth import secret_digest
    from voice_agent_api.security.middleware import Protection

    ledger = InMemoryBudgetLedger()
    service, port = speech_service(ledger, seconds=5)
    world = AgentWorld([])
    app = create_app(
        world.catalog,
        world.book,
        lambda: NOW,
        signing_key=KEY,
        speech=service,
        protection=Protection(secret_digest(SECRET), limits(Clock())),
    )
    client = TestClient(app, raise_server_exceptions=False)
    data, headers = audio("audio/wav")
    response = client.post("/v1/speech/transcriptions", headers={**AUTH, **headers}, content=data)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "demo_budget_reached"
    assert port.calls == 0
