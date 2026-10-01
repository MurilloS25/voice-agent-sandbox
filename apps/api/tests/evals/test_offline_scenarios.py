"""Replays the version-controlled scenarios (`evals/agent/scenarios`) through the real
orchestrator with a scripted model. This checks the application's guarantees (allow-list,
validation, no writes, no leaks, recovery), not model quality: a live run is a later phase."""

import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

from tests.agent.offline import offline_guard
from tests.agent.support import AgentWorld, Step, call_tools, say
from tests.support import NOW
from voice_agent_api.agent.contracts import AgentTurnResponse
from voice_agent_api.domain.commands import confirm_appointment, propose_appointment

__all__ = ["offline_guard"]

SCENARIO_DIR = Path(__file__).resolve().parents[4] / "evals" / "agent" / "scenarios"
FILES = sorted(SCENARIO_DIR.glob("*.json"))
TOKEN = re.compile(r"v1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")
UUID_TEXT = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
CATEGORIES = {"task", "safety", "recovery"}
# "…is booked", "…has been confirmed", unless negated ("nothing is booked", "not booked").
CLAIMS_BOOKING = re.compile(
    r"(?<!nothing )(?<!not )\b(is|has been|was|got) (now )?(booked|confirmed|saved)\b",
    re.IGNORECASE,
)


def load(path: Path) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return data


def steps_for(turn: dict[str, Any]) -> list[Step]:
    steps: list[Step] = []
    for item in turn["script"]:
        if "tool_calls" in item:
            steps.append(call_tools(*((c["name"], c["args"]) for c in item["tool_calls"])))
        else:
            steps.append(say(item["text"]))
    return steps


def fill_slot(world: AgentWorld, service_id: str, start: str) -> None:
    """Other customers take every bench for a slot, through the domain's own commands."""
    start_at = datetime.fromisoformat(start.replace("Z", "+00:00"))
    for _ in range(world.catalog.business().bench_capacity):
        review = propose_appointment(world.book, service_id, start_at, NOW, uuid4)
        confirm_appointment(world.book, review.proposal, NOW, source="eval_other_customer")


def check_expectations(expect: dict[str, Any], response: AgentTurnResponse, where: str) -> None:
    if "outcome" in expect:
        assert response.outcome == expect["outcome"], where
    requested = [e.tool for e in response.events if e.kind == "tool_requested"]
    if "tools_called_in_order" in expect:
        assert requested == expect["tools_called_in_order"], where
    codes = [e.code for e in response.events if e.kind == "tool_result"]
    if "tool_result_codes" in expect:
        assert codes == expect["tool_result_codes"], where
    guards = [e.code for e in response.events if e.kind == "guardrail"]
    if "guardrails" in expect:
        assert guards == expect["guardrails"], where
    if "review_ready" in expect:
        assert (response.booking_review is not None) == expect["review_ready"], where
    reply = response.reply.text.lower()
    if "reply_should_mention_any" in expect:
        assert any(s.lower() in reply for s in expect["reply_should_mention_any"]), where
    for pattern in expect.get("reply_must_not_match", []):
        assert not re.search(pattern, reply, re.IGNORECASE), where
    if expect.get("claims_no_booking"):
        assert not CLAIMS_BOOKING.search(reply), where


def test_the_scenario_set_is_complete_and_well_formed() -> None:
    scenarios = [load(p) for p in FILES]
    assert len(scenarios) == 12
    assert len({s["id"] for s in scenarios}) == 12
    assert {s["category"] for s in scenarios} == CATEGORIES
    for path, scenario in zip(FILES, scenarios, strict=True):
        assert path.stem == scenario["id"]
        assert scenario["turns"], scenario["id"]
        for turn in scenario["turns"]:
            assert {"user", "script", "expect"} <= set(turn), scenario["id"]


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.stem)
def test_scenario(path: Path, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="voice_agent_api")
    scenario = load(path)
    world = AgentWorld([step for turn in scenario["turns"] for step in steps_for(turn)])
    fills = 0
    responses: list[AgentTurnResponse] = []

    for number, turn in enumerate(scenario["turns"], start=1):
        for action in turn.get("before", []):
            fill_slot(world, **action["fill_slot"])
            fills += world.catalog.business().bench_capacity
        response = world.send(turn["user"])
        responses.append(response)
        check_expectations(turn["expect"], response, f"{scenario['id']} turn {number}")

    # Invariants for every scenario.
    assert world.stored_bookings() == fills, "the agent must never create an appointment"
    service = world.catalog.service_by_id("flat-repair")
    assert service is not None and service.price.amount_minor == 1500

    for response in responses:
        events_and_reply = response.model_dump_json(exclude={"booking_review"})
        assert not TOKEN.search(events_and_reply)
        ready = [e for e in response.events if e.kind == "booking_review_ready"]
        assert len(ready) == (1 if response.booking_review else 0)
        assert not UUID_TEXT.search("\n".join(e.model_dump_json() for e in response.events))
    logs = "\n".join(r.getMessage() for r in caplog.records)
    assert not TOKEN.search(logs) and not UUID_TEXT.search(logs)
    traffic = "\n".join(str(m.content) for call in world.model.calls for m in call)
    assert not TOKEN.search(traffic)
