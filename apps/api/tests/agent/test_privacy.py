"""What may and may not leave the agent.

The proposal token is an opaque capability that the browser must return to confirm. It may
appear only in the typed `booking_review` payload. These tests inspect the timeline, the reply,
the logs and everything sent to the model separately from that authorized payload.
"""

import logging
import re

import pytest
from langchain_core.messages import BaseMessage

from tests.agent.support import (
    SLOT_DATE,
    AgentWorld,
    GateBook,
    call_tools,
    say,
)
from voice_agent_api.agent.contracts import AgentTurnResponse
from voice_agent_api.agent.errors import ProviderError
from voice_agent_api.domain.errors import StorageUnavailable

TOKEN = re.compile(r"v1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")
UUID_TEXT = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
LEAK_MARKER = "internal-exception-detail-7731"
# Chosen by the (untrusted) model. It is part of the model's own traffic, but a rejected value
# must never be echoed into the timeline, the reply or the logs.
MODEL_ARG = "model-chosen-argument-4410"
USER_TEXT = "my-distinctive-user-text"

FIND = ("find_available_slots", {"service_id": "flat-repair", "date": SLOT_DATE})
PREPARE = ("prepare_booking_review", {"slot_id": "S1"})


def model_facing(world: AgentWorld) -> str:
    parts: list[str] = []
    for call in world.model.calls:
        for message in call:
            parts.append(str(message.content))
            parts.append(str(getattr(message, "tool_calls", "")))
    return "\n".join(parts)


def without_review(response: AgentTurnResponse) -> str:
    """Everything the visitor and the timeline see except the authorized review payload."""
    return response.model_dump_json(exclude={"booking_review"})


def scenario_review() -> tuple[AgentWorld, list[AgentTurnResponse]]:
    world = AgentWorld([call_tools(FIND), say("times"), call_tools(PREPARE), say("review below")])
    return world, [world.send(f"{USER_TEXT} times"), world.send(f"{USER_TEXT} first")]


def scenario_guardrails() -> tuple[AgentWorld, list[AgentTurnResponse]]:
    world = AgentWorld(
        [
            call_tools(("confirm_appointment", {"proposal_token": "x"}), ("list_services", {})),
            call_tools(("find_available_slots", {"service_id": MODEL_ARG, "date": MODEL_ARG})),
            say("ok"),
        ]
    )
    return world, [world.send(USER_TEXT)]


def scenario_provider_failure() -> tuple[AgentWorld, list[AgentTurnResponse]]:
    world = AgentWorld([ProviderError("model_unavailable"), RuntimeError(LEAK_MARKER)])
    return world, [world.send(USER_TEXT), world.send(USER_TEXT)]


def scenario_tool_failures() -> tuple[AgentWorld, list[AgentTurnResponse]]:
    world = AgentWorld([call_tools(FIND), say("a"), call_tools(FIND), say("b")], wrap_book=GateBook)
    gate = world.wrapped_book
    assert isinstance(gate, GateBook)
    gate.fail = StorageUnavailable()
    first = world.send(USER_TEXT)
    gate.fail = RuntimeError(LEAK_MARKER)
    return world, [first, world.send(USER_TEXT)]


def scenario_review_then_failure() -> tuple[AgentWorld, list[AgentTurnResponse]]:
    world = AgentWorld([call_tools(FIND), say("t"), call_tools(PREPARE), RuntimeError(LEAK_MARKER)])
    return world, [world.send(USER_TEXT), world.send(USER_TEXT)]


SCENARIOS = [
    scenario_review,
    scenario_guardrails,
    scenario_provider_failure,
    scenario_tool_failures,
    scenario_review_then_failure,
]


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda s: s.__name__)
def test_timeline_reply_and_model_traffic_hold_no_token_id_or_exception_text(
    scenario: object, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="voice_agent_api")
    world, responses = scenario()  # type: ignore[operator]

    visible = "\n".join(without_review(r) for r in responses)
    # Conversation and turn ids are part of the response envelope by design; the timeline events
    # themselves carry no identifier at all.
    events = "\n".join(e.model_dump_json() for r in responses for e in r.events)
    traffic = model_facing(world)
    logs = "\n".join(record.getMessage() for record in caplog.records)

    assert not TOKEN.search(visible)
    assert not TOKEN.search(traffic)
    assert not TOKEN.search(logs)
    assert not UUID_TEXT.search(events)
    assert not UUID_TEXT.search(traffic)
    assert not UUID_TEXT.search(logs)
    for text in (visible, traffic, logs):
        assert LEAK_MARKER not in text
    for text in (visible, logs):
        assert MODEL_ARG not in text
    assert USER_TEXT not in logs  # message text is never logged
    assert "<think>" not in visible


def test_the_token_appears_only_in_the_authorized_booking_review_payload() -> None:
    _, responses = scenario_review()
    review = responses[-1].booking_review
    assert review is not None
    whole = responses[-1].model_dump_json()

    assert whole.count(review.proposal_token) == 1
    assert review.proposal_token not in without_review(responses[-1])
    assert review.proposal_token not in responses[0].model_dump_json()


def test_a_review_that_degrades_still_carries_the_token_only_in_the_review() -> None:
    _, responses = scenario_review_then_failure()
    final = responses[-1]
    assert final.outcome == "degraded" and final.booking_review is not None
    assert final.booking_review.proposal_token not in without_review(final)


def test_the_model_is_never_told_about_proposal_ids_or_tokens() -> None:
    world, _ = scenario_review()
    traffic = model_facing(world).lower()
    assert "proposal_token" not in traffic
    assert "proposal id" not in traffic


def test_message_content_helper_covers_tool_messages() -> None:
    world, _ = scenario_review()
    kinds = {type(m).__name__ for call in world.model.calls for m in call}
    assert {"SystemMessage", "HumanMessage", "ToolMessage"} <= kinds
    assert all(isinstance(m, BaseMessage) for call in world.model.calls for m in call)
