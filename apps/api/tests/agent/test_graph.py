"""Graph edge cases: tool-call pairing and caps, recursion, mid-review budgets, compose fallback,
and lifecycle wiring."""

import asyncio
import logging

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from tests.agent.support import (
    KEY,
    SLOT_DATE,
    AgentWorld,
    call_tools,
    kinds,
    say,
)
from tests.support import NOW
from voice_agent_api.agent.limits import AgentLimits
from voice_agent_api.agent.orchestrator import REVIEW_NOTICE, AgentService
from voice_agent_api.factory import create_app

FIND = ("find_available_slots", {"service_id": "flat-repair", "date": SLOT_DATE})
PREPARE = ("prepare_booking_review", {"slot_id": "S1"})


def paired(world: AgentWorld) -> None:
    """Every ToolMessage the model was sent answers a tool call of the preceding AIMessage."""
    for call in world.model.calls:
        wanted: set[str] = set()
        for message in call:
            if isinstance(message, AIMessage):
                wanted = {str(c["id"]) for c in message.tool_calls} | {
                    str(c["id"]) for c in message.invalid_tool_calls
                }
            if isinstance(message, ToolMessage):
                assert message.tool_call_id in wanted


def test_a_tool_call_without_an_id_is_given_one_and_paired() -> None:
    message = AIMessage(
        content="",
        tool_calls=[{"name": "list_services", "args": {}, "id": None, "type": "tool_call"}],
    )
    world = AgentWorld([message, say("done")])
    response = world.send("services?")

    assert response.outcome == "completed"
    second_call = world.model.calls[1]
    ai = next(m for m in second_call if isinstance(m, AIMessage))
    tool = next(m for m in second_call if isinstance(m, ToolMessage))
    assert ai.tool_calls[0]["id"] and ai.tool_calls[0]["id"] == tool.tool_call_id
    paired(world)


def test_unparseable_tool_calls_are_rejected_and_paired() -> None:
    message = AIMessage(
        content="",
        invalid_tool_calls=[
            {"name": "find_available_slots", "args": "{bad json", "id": "inv1", "error": "x"},
            {"name": "list_services", "args": "{", "id": None, "error": "y"},
        ],
    )
    world = AgentWorld([message, say("sorry")])
    response = world.send("times")

    guards = [e for e in response.events if e.kind == "guardrail"]
    assert [g.code for g in guards] == ["invalid_tool_input", "invalid_tool_input"]
    assert guards[0].issues == ["arguments:unparseable"]
    assert "{bad json" not in response.model_dump_json()
    assert response.outcome == "completed"
    paired(world)


def test_hundreds_of_tool_calls_in_one_message_are_capped_with_one_guardrail_event() -> None:
    spam = call_tools(*[("list_services", {})] * 300)
    world = AgentWorld([spam, say("done")])
    response = world.send("spam")

    assert kinds(response).count("tool_result") == 3
    guards = [e for e in response.events if e.kind == "guardrail"]
    assert [g.code for g in guards] == ["tool_budget_exceeded"]
    assert len(response.events) < 12
    paired(world)


def test_a_recursion_limit_error_degrades_instead_of_failing() -> None:
    world = AgentWorld(
        [call_tools(("list_services", {})), say("never")], limits=AgentLimits(recursion_limit=2)
    )
    response = world.send("loop")

    assert response.outcome == "degraded"
    assert any(e.kind == "turn_error" and e.code == "internal_error" for e in response.events)


def test_the_model_call_budget_in_the_middle_of_a_review_keeps_the_review() -> None:
    world = AgentWorld(
        [
            call_tools(FIND),
            say("times"),
            call_tools(PREPARE),
            call_tools(("list_services", {})),
        ],
        limits=AgentLimits(max_model_calls=2),
    )
    world.send("times")
    response = world.send("first")

    assert response.outcome == "degraded"
    assert response.reply.text == REVIEW_NOTICE
    assert response.booking_review is not None
    assert any(
        e.kind == "guardrail" and e.code == "model_call_budget_exceeded" for e in response.events
    )
    assert kinds(response).count("booking_review_ready") == 1


def test_a_bug_while_building_the_response_degrades_without_leaking(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="voice_agent_api")
    world = AgentWorld([call_tools(FIND), say("times"), call_tools(PREPARE), say("review")])
    world.send("times")

    def broken(*args: object, **kwargs: object) -> None:
        raise ValueError("input_value=v1.leakedtoken.leakedsignature")

    monkeypatch.setattr(AgentService, "_compose", broken)
    request = world.request("first")
    response = world.service.handle_turn(request)

    assert response.outcome == "degraded"
    assert response.booking_review is None
    assert any(e.kind == "turn_error" and e.code == "internal_error" for e in response.events)
    assert "leakedtoken" not in response.model_dump_json()
    assert "leakedtoken" not in "\n".join(r.getMessage() for r in caplog.records)
    # Committed and cached: a retry returns the same bytes without calling the model.
    calls = len(world.model.calls)
    assert world.service.handle_turn(request).model_dump_json() == response.model_dump_json()
    assert len(world.model.calls) == calls


def test_the_app_lifespan_opens_and_closes_the_agent() -> None:
    world = AgentWorld([say("hi")])
    app = create_app(world.catalog, world.book, lambda: NOW, signing_key=KEY, agent=world.service)
    caller = world.service._caller  # the pool the lifespan must shut down

    async def run() -> None:
        async with app.router.lifespan_context(app):
            assert not caller.closed

    asyncio.run(run())
    assert caller.closed
