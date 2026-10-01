"""A provider-generated, UUID-shaped `tool_call_id` is protocol correlation data.

It must survive in the private provider traffic (the next request needs it to pair a tool result
with its call) and must appear nowhere public. Application identifiers stay out of everything.
"""

import json
import logging
from uuid import UUID

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from tests.agent.privacy import (
    Violation,
    audit,
    correlation_ids,
    describe,
    messages_from_langchain,
)
from tests.agent.support import SLOT_DATE, AgentWorld, say
from voice_agent_api.agent.contracts import AgentTurnResponse

FIND_ID = "3f2b8c1e-6a4d-4e0b-9d3a-1b7c5e9f0a21"  # what a provider may generate
PREPARE_ID = "9a1c7d52-0e3b-4f86-b2c4-7d6e5f4a3b10"


def tool_message(name: str, args: dict[str, object], call_id: str) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": args, "id": call_id, "type": "tool_call"}],
    )


def run(caplog: pytest.LogCaptureFixture) -> tuple[AgentWorld, list[AgentTurnResponse]]:
    caplog.set_level(logging.DEBUG, logger="voice_agent_api")
    world = AgentWorld(
        [
            tool_message(
                "find_available_slots", {"service_id": "flat-repair", "date": SLOT_DATE}, FIND_ID
            ),
            say("Here are times."),
            tool_message("prepare_booking_review", {"slot_id": "S1"}, PREPARE_ID),
            say("The review is below."),
        ]
    )
    return world, [world.send("times?"), world.send("the first one")]


def provider_messages(world: AgentWorld) -> list[dict[str, object]]:
    return [m for call in world.model.calls for m in messages_from_langchain(call)]


def public_text(responses: list[AgentTurnResponse]) -> tuple[str, str]:
    events = json.dumps([e.model_dump(mode="json") for r in responses for e in r.events])
    return events, "\n".join(r.reply.text for r in responses)


def forbidden(world: AgentWorld, responses: list[AgentTurnResponse]) -> dict[str, set[str]]:
    return {
        "conversation_id": {str(world.conversation_id)},
        "client_turn_id": {str(r.client_turn_id) for r in responses},
        # The test world issues proposal ids UUID(int=1), UUID(int=2), ...
        "proposal_id": {str(UUID(int=n)) for n in range(1, 6)},
    }


def test_the_correlation_id_is_preserved_in_the_provider_protocol(
    caplog: pytest.LogCaptureFixture,
) -> None:
    world, _ = run(caplog)

    # The second request of turn 1 replays the tool call and its result with the same id.
    second = world.model.calls[1]
    asked = next(m for m in second if isinstance(m, AIMessage))
    answered = next(m for m in second if isinstance(m, ToolMessage))
    assert asked.tool_calls[0]["id"] == FIND_ID
    assert answered.tool_call_id == FIND_ID
    assert {FIND_ID, PREPARE_ID} <= correlation_ids(provider_messages(world))


def test_the_correlation_id_appears_on_no_public_surface(
    caplog: pytest.LogCaptureFixture,
) -> None:
    _, responses = run(caplog)
    events, replies = public_text(responses)
    logs = "\n".join(r.getMessage() for r in caplog.records)

    for cid in (FIND_ID, PREPARE_ID):
        assert cid not in events
        assert cid not in replies
        assert cid not in logs
        # Nor anywhere in the API response, review payload included.
        assert all(cid not in r.model_dump_json() for r in responses)


def test_the_taxonomy_holds_for_a_turn_with_uuid_shaped_correlation_ids(
    caplog: pytest.LogCaptureFixture,
) -> None:
    world, responses = run(caplog)
    events, replies = public_text(responses)

    violations = audit(
        events_text=events,
        reply_text=replies,
        logs_text="\n".join(r.getMessage() for r in caplog.records),
        provider_messages=provider_messages(world),
        forbidden_ids=forbidden(world, responses),
    )
    assert violations == [], describe(violations)


def test_application_identifiers_never_reach_the_provider_or_the_public_surfaces(
    caplog: pytest.LogCaptureFixture,
) -> None:
    world, responses = run(caplog)
    events, replies = public_text(responses)
    logs = "\n".join(r.getMessage() for r in caplog.records)
    traffic = json.dumps(provider_messages(world))

    for values in forbidden(world, responses).values():
        for value in values:
            for text in (events, replies, logs, traffic):
                assert value not in text
    # The review exists, so a proposal id was minted: it is still nowhere in provider traffic.
    assert responses[-1].booking_review is not None
    assert str(UUID(int=1)) not in traffic


def test_the_proposal_token_is_only_in_the_authorized_payload(
    caplog: pytest.LogCaptureFixture,
) -> None:
    world, responses = run(caplog)
    token = responses[-1].booking_review.proposal_token  # type: ignore[union-attr]
    events, replies = public_text(responses)

    assert token not in events + replies + json.dumps(provider_messages(world))
    assert responses[-1].model_dump_json().count(token) == 1


# -- negative controls: every kind of leak is caught, and the report holds no value ---------------

KEY_VALUE = "value-that-must-never-be-printed-5521"
HARD_VALUE = 'quote " back\\slash\nnewline é'  # escapes must not hide a leak
CONVERSATION = "11111111-2222-4333-8444-555555555555"
OTHER_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
TOKEN = "v1.eyJhYmNkZWZnaCJ9.c2lnbmF0dXJlMTIz"
FORBIDDEN = {"conversation_id": {CONVERSATION}}


def base_audit(
    *,
    events: str = "[]",
    reply: str = "ok",
    logs: str = "",
    provider: list[dict[str, object]] | None = None,
    api_key: str = "",
    reasoning: tuple[str, ...] = (),
) -> list[Violation]:
    return audit(
        events_text=events,
        reply_text=reply,
        logs_text=logs,
        provider_messages=provider if provider is not None else [{"role": "user", "content": "hi"}],
        forbidden_ids=FORBIDDEN,
        reasoning_texts=reasoning,
        api_key=api_key,
    )


def wire(call_id: str, args: dict[str, object] | None = None) -> list[dict[str, object]]:
    """A tool call and its result, in the OpenAI wire shape."""
    return [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": "find_available_slots",
                        "arguments": json.dumps(args or {}),
                    },
                }
            ],
        },
        {"role": "tool", "tool_call_id": call_id, "content": "{}"},
    ]


CASES: list[tuple[str, dict[str, object], list[Violation]]] = [
    (
        "conversation id in provider content",
        {"provider": [{"role": "system", "content": f"id {CONVERSATION}"}]},
        [Violation("provider", "conversation_id"), Violation("provider", "uuid_shaped_identifier")],
    ),
    (
        "application id inside tool-call arguments",
        {"provider": wire("call_abc123", {"service_id": CONVERSATION})},
        [Violation("provider", "conversation_id"), Violation("provider", "uuid_shaped_identifier")],
    ),
    ("token in events", {"events": f'["{TOKEN}"]'}, [Violation("events", "proposal_token")]),
    (
        "token in provider content",
        {"provider": [{"role": "tool", "tool_call_id": "call_abc123", "content": TOKEN}]},
        [Violation("provider", "proposal_token")],
    ),
    (
        "application id in the reply",
        {"reply": f"see {CONVERSATION}"},
        [Violation("reply", "conversation_id"), Violation("reply", "uuid_shaped_identifier")],
    ),
    (
        "an uppercase uuid in the logs",
        {"logs": f"x {OTHER_UUID.upper()}"},
        [Violation("logs", "uuid_shaped_identifier")],
    ),
    (
        "a stray uuid in provider content",
        {"provider": [{"role": "user", "content": f"x {OTHER_UUID}"}]},
        [Violation("provider", "uuid_shaped_identifier")],
    ),
    (
        "a uuid in a tool-call function name field",
        {
            "provider": [
                {
                    "role": "assistant",
                    "tool_calls": [{"id": "call_abc123", "function": {"name": OTHER_UUID}}],
                }
            ]
        },
        [Violation("provider", "uuid_shaped_identifier")],
    ),
    (
        "a non-uuid correlation id on a public surface",
        {"provider": wire("call_abc123"), "logs": "tool call_abc123 ran"},
        [Violation("logs", "provider_tool_call_id")],
    ),
    (
        "a correlation id in provider content",
        {"provider": [*wire("call_abc123"), {"role": "user", "content": "echo call_abc123"}]},
        [Violation("provider", "provider_tool_call_id")],
    ),
    (
        "a correlation id in tool-call arguments",
        {"provider": wire("call_abc123", {"note": "call_abc123"})},
        [Violation("provider", "provider_tool_call_id")],
    ),
    (
        "the api key in the reply",
        {"reply": f"key {KEY_VALUE}", "api_key": KEY_VALUE},
        [Violation("reply", "api_key")],
    ),
    (
        "an api key with characters that JSON escapes, in events",
        {"events": json.dumps([{"text": f"k {HARD_VALUE}"}]), "api_key": HARD_VALUE},
        [Violation("events", "api_key")],
    ),
    (
        "reasoning text in the logs",
        {"logs": f"thinking {KEY_VALUE}", "reasoning": (KEY_VALUE,)},
        [Violation("logs", "reasoning")],
    ),
    (
        "reasoning text with escapes, in provider content",
        {
            "provider": [{"role": "assistant", "content": f"r {HARD_VALUE}"}],
            "reasoning": (HARD_VALUE,),
        },
        [Violation("provider", "reasoning")],
    ),
    (
        "a top-level reasoning field",
        {"provider": [{"role": "assistant", "content": "", "reasoning": "x"}]},
        [Violation("provider", "reasoning_field")],
    ),
    (
        "a nested reasoning field",
        {
            "provider": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{"id": "call_abc123", "function": {"reasoning_content": "x"}}],
                }
            ]
        },
        [Violation("provider", "reasoning_field")],
    ),
]


@pytest.mark.parametrize(("name", "kwargs", "expected"), CASES, ids=[c[0] for c in CASES])
def test_every_kind_of_leak_is_reported_by_surface_and_type_only(
    name: str, kwargs: dict[str, object], expected: list[Violation]
) -> None:
    violations = base_audit(**kwargs)  # type: ignore[arg-type]

    assert violations == expected, name
    report = describe(violations) + repr(violations) + str(violations)
    for value in (
        CONVERSATION,
        OTHER_UUID,
        OTHER_UUID.upper(),
        TOKEN,
        KEY_VALUE,
        HARD_VALUE,
        "call_abc123",
    ):
        assert value not in report


def test_a_correlation_id_in_its_two_protocol_fields_is_allowed() -> None:
    for call_id in (FIND_ID, "call_abc123", "fc_" + FIND_ID):
        assert base_audit(provider=wire(call_id)) == []


def test_a_correlation_id_on_a_public_surface_is_flagged() -> None:
    violations = base_audit(provider=wire(FIND_ID), logs=f"call {FIND_ID}")
    assert Violation("logs", "provider_tool_call_id") in violations
    assert Violation("logs", "uuid_shaped_identifier") in violations
    assert FIND_ID not in describe(violations)


def test_the_same_uuid_in_content_is_not_correlation_data() -> None:
    messages = wire(FIND_ID)
    messages[1]["content"] = f"result mentions {FIND_ID}"
    assert Violation("provider", "provider_tool_call_id") in base_audit(provider=messages)


def test_a_missing_or_short_id_is_not_treated_as_a_correlation_id() -> None:
    # `None` ids exist in LangChain messages. The text "None" must not be flagged because of them.
    messages = wire("call_abc123")
    messages[0]["tool_calls"][0]["id"] = None  # type: ignore[index]
    messages[1]["tool_call_id"] = ""
    assert base_audit(provider=messages, reply="None available", logs="None") == []


def test_a_short_id_is_matched_as_a_whole_token_only() -> None:
    messages = wire("call_1")
    assert base_audit(provider=messages, logs="call_10 and call_11 ran") == []
    assert Violation("logs", "provider_tool_call_id") in base_audit(
        provider=messages, logs="the call_1 ran"
    )


def test_empty_forbidden_values_never_match() -> None:
    assert (
        audit(
            events_text="x",
            reply_text="y",
            logs_text="z",
            provider_messages=[{"role": "user", "content": "w"}],
            forbidden_ids={"conversation_id": {""}},
            reasoning_texts=("",),
            api_key="",
        )
        == []
    )


def test_the_langchain_converter_keeps_tool_call_arguments_visible_to_the_audit() -> None:
    message = AIMessage(
        content="",
        tool_calls=[
            {
                "name": "find_available_slots",
                "args": {"service_id": CONVERSATION},
                "id": "call_abc123",
                "type": "tool_call",
            }
        ],
        invalid_tool_calls=[
            {"name": "x", "args": f"{{raw {OTHER_UUID}", "id": "call_def456", "error": "e"}
        ],
    )
    wired = messages_from_langchain(
        [message, ToolMessage(content="{}", tool_call_id="call_abc123")]
    )

    assert base_audit(provider=wired) == [
        Violation("provider", "conversation_id"),
        Violation("provider", "uuid_shaped_identifier"),
    ]
    assert {"call_abc123", "call_def456"} <= correlation_ids(wired)


def test_the_converter_marks_a_reasoning_field_on_a_message() -> None:
    message = AIMessage(content="hi", additional_kwargs={"reasoning_content": "x"})
    assert base_audit(provider=messages_from_langchain([message])) == [
        Violation("provider", "reasoning_field")
    ]
