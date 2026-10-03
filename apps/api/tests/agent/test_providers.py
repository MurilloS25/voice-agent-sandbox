"""The provider adapter, offline: a real `ChatGroq` over an injected mock HTTP transport.

No request leaves the machine: the transport answers every call, and the `offline_guard`
fixture (tests/agent/conftest.py) fails any non-loopback socket connection and keeps LangSmith
tracing off. The key used here is a made-up string.
"""

import json
import logging
import socket
from typing import Any

import groq
import httpx
import pytest
from langchain_core.messages import HumanMessage
from pydantic import SecretStr

from tests.agent.support import SLOT_DATE, AgentWorld
from voice_agent_api.agent.errors import ProviderError
from voice_agent_api.agent.providers import build_chat_model, classify_provider_error
from voice_agent_api.agent.tools import tool_specs
from voice_agent_api.config import ConfigError, Settings
from voice_agent_api.factory import build_agent, create_app_from_settings

FAKE_KEY = "fake-offline-credential-for-tests-0001"
MODEL_ID = "some/model-id"
REASONING = "PRIVATE-REASONING-TEXT-9921"


def settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "agent_provider": "groq",
        "groq_api_key": SecretStr(FAKE_KEY),
        "agent_model": MODEL_ID,
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def completion(
    content: str = "hi",
    tool_calls: list[dict[str, Any]] | None = None,
    reasoning: str | None = None,
) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls
    if reasoning is not None:
        message["reasoning"] = reasoning
    return {
        "id": "cmpl-test",
        "object": "chat.completion",
        "created": 1,
        "model": MODEL_ID,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": "tool_calls" if tool_calls else "stop",
            }
        ],
        "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
    }


class Transport:
    """A scripted HTTP server. Records every request; each reply is a status and a JSON body, or
    an exception to raise."""

    def __init__(self, *replies: tuple[int, dict[str, Any]] | Exception) -> None:
        self._replies = list(replies)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        reply = self._replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        status, body = reply
        return httpx.Response(status, json=body)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self))

    def body(self, index: int = 0) -> dict[str, Any]:
        loaded: dict[str, Any] = json.loads(self.requests[index].content)
        return loaded


def ask(transport: Transport, **overrides: Any) -> Any:
    model = build_chat_model(settings(**overrides), http_client=transport.client())
    assert model is not None
    return model.bind_tools(tool_specs(), tool_choice="auto").invoke([HumanMessage("hello")])


# -- construction and the request ---------------------------------------------------------------


def test_a_disabled_provider_builds_no_model() -> None:
    assert build_chat_model(Settings(_env_file=None)) is None
    assert build_agent(Settings(_env_file=None), None, None, b"k" * 32) is None  # type: ignore[arg-type]


def test_the_model_is_built_with_the_verified_limits_and_no_retries() -> None:
    model = build_chat_model(settings(), http_client=Transport().client())
    assert model is not None
    assert (model.request_timeout, model.max_retries) == (8.0, 0)  # type: ignore[attr-defined]
    assert model.model_name == MODEL_ID  # type: ignore[attr-defined]
    assert model.max_tokens == 512  # type: ignore[attr-defined]


def test_the_request_carries_the_expected_parameters_and_tool_schema() -> None:
    transport = Transport((200, completion()))
    ask(transport)

    assert len(transport.requests) == 1
    request = transport.requests[0]
    assert request.method == "POST"
    assert str(request.url) == "https://api.groq.com/openai/v1/chat/completions"
    body = transport.body()
    assert body["model"] == MODEL_ID
    assert body["max_tokens"] == 512
    assert body["temperature"] < 1e-6  # the SDK sends a tiny value for zero
    assert body["reasoning_effort"] == "low"
    assert body["include_reasoning"] is False
    assert body["reasoning_format"] is None  # the two controls are never both set
    assert body["tool_choice"] == "auto"
    assert body["stream"] is False
    assert [t["function"]["name"] for t in body["tools"]] == [
        "get_business_info",
        "list_services",
        "find_available_slots",
        "prepare_booking_review",
        "discard_booking_review",
    ]
    schema = body["tools"][2]["function"]["parameters"]
    assert schema["properties"]["service_id"]["pattern"] == "^[a-z0-9-]{1,64}$"
    assert schema["additionalProperties"] is False
    assert body["messages"] == [{"role": "user", "content": "hello"}]


def test_the_key_travels_only_in_the_authorization_header() -> None:
    transport = Transport((200, completion()))
    ask(transport)

    assert transport.requests[0].headers["authorization"] == f"Bearer {FAKE_KEY}"
    assert FAKE_KEY not in transport.requests[0].content.decode()
    assert FAKE_KEY not in str(transport.requests[0].url)


def test_the_qwen_style_reasoning_control_sends_a_hidden_format_instead() -> None:
    transport = Transport((200, completion()))
    ask(transport, agent_reasoning_control="reasoning_format", agent_reasoning_effort="off")

    body = transport.body()
    assert body["reasoning_format"] == "hidden"
    assert "include_reasoning" not in body or body["include_reasoning"] is None
    assert "reasoning_effort" in body and body["reasoning_effort"] is None  # sent as null


def test_nothing_in_the_adapter_hard_codes_a_model_id() -> None:
    transport = Transport((200, completion()))
    ask(transport, agent_model="another/vendor-model.v2")
    assert transport.body()["model"] == "another/vendor-model.v2"


# -- error mapping and the absence of retries ---------------------------------------------------


@pytest.mark.parametrize(
    ("reply", "code"),
    [
        ((429, {"error": {"message": "slow down"}}), "model_rate_limited"),
        ((500, {"error": {"message": "boom"}}), "model_unavailable"),
        ((503, {"error": {"message": "overloaded"}}), "model_unavailable"),
        ((401, {"error": {"message": "bad key"}}), "model_unavailable"),
        ((400, {"error": {"message": "tool_use_failed"}}), "model_bad_output"),
        (httpx.ReadTimeout("slow"), "model_timeout"),
        (httpx.ConnectError("down"), "model_unavailable"),
    ],
)
def test_provider_failures_map_to_codes_with_exactly_one_request(reply: Any, code: str) -> None:
    transport = Transport(reply)
    with pytest.raises(Exception) as caught:
        ask(transport)

    assert classify_provider_error(caught.value) == code
    assert len(transport.requests) == 1  # no automatic retry, even for 429 and 5xx


def test_classification_uses_codes_and_class_names_never_messages() -> None:
    assert classify_provider_error(ProviderError("model_bad_output")) == "model_bad_output"
    assert classify_provider_error(ProviderError("not-a-code")) == "model_unavailable"
    assert classify_provider_error(TimeoutError("anything")) == "model_timeout"
    assert classify_provider_error(RuntimeError("rate limit exceeded 429")) == "model_unavailable"

    class Http(Exception):
        def __init__(self, status: int) -> None:
            self.status_code = status

    assert classify_provider_error(Http(408)) == "model_timeout"
    assert classify_provider_error(Http(504)) == "model_timeout"
    assert classify_provider_error(Http(422)) == "model_bad_output"
    assert classify_provider_error(Http(502)) == "model_unavailable"


def test_the_sdk_exception_types_classify_as_expected() -> None:
    request = httpx.Request("POST", "https://api.groq.com/x")
    assert classify_provider_error(groq.APITimeoutError(request=request)) == "model_timeout"
    assert classify_provider_error(groq.APIConnectionError(request=request)) == "model_unavailable"
    limited = groq.RateLimitError("m", response=httpx.Response(429, request=request), body=None)
    assert classify_provider_error(limited) == "model_rate_limited"


# -- through the whole agent --------------------------------------------------------------------


def tool_call_message(name: str, args: dict[str, Any]) -> dict[str, Any]:
    return completion(
        content="",
        tool_calls=[
            {
                "id": "call_1",
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)},
            }
        ],
        reasoning=REASONING,
    )


def agent_world(transport: Transport) -> AgentWorld:
    model = build_chat_model(settings(), http_client=transport.client())
    assert model is not None
    return AgentWorld(chat_model=model)


def test_a_full_turn_runs_through_the_adapter_and_hides_reasoning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    transport = Transport(
        (
            200,
            tool_call_message(
                "find_available_slots", {"service_id": "flat-repair", "date": SLOT_DATE}
            ),
        ),
        (200, completion("There are morning times.", reasoning=REASONING)),
    )
    world = agent_world(transport)
    response = world.send("Do you have times on Tuesday?")

    assert response.outcome == "completed"
    assert response.reply.text == "There are morning times."
    assert [e.kind for e in response.events] == [
        "user_message",
        "tool_requested",
        "tool_result",
        "assistant_message",
    ]
    assert len(transport.requests) == 2

    everything = response.model_dump_json() + " ".join(r.getMessage() for r in caplog.records)
    assert REASONING not in everything
    assert FAKE_KEY not in everything
    # The reasoning from the first reply was not replayed to the provider on the second request.
    assert REASONING not in transport.requests[1].content.decode()
    # The tool result went back to the model as a paired tool message.
    second = transport.body(1)["messages"]
    assert second[-1]["role"] == "tool" and second[-1]["tool_call_id"] == "call_1"
    assert world.stored_bookings() == 0


def test_a_provider_failure_inside_a_turn_degrades_with_one_request_and_no_leak(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    secret_detail = "provider-detail-must-not-leak"
    transport = Transport((429, {"error": {"message": secret_detail}}))
    world = agent_world(transport)
    response = world.send("hello there")

    assert response.outcome == "degraded"
    assert any(
        e.kind == "provider_error" and e.code == "model_rate_limited" for e in response.events
    )
    assert len(transport.requests) == 1
    logs = " ".join(r.getMessage() for r in caplog.records)
    for text in (response.model_dump_json(), logs):
        assert secret_detail not in text
        assert FAKE_KEY not in text
        assert "hello there" not in logs  # user text is not logged


def test_a_hung_provider_ends_at_the_call_timeout_without_a_retry() -> None:
    transport = Transport(httpx.ReadTimeout("hung"))
    world = agent_world(transport)
    response = world.send("hello")

    assert any(e.kind == "provider_error" and e.code == "model_timeout" for e in response.events)
    assert len(transport.requests) == 1


# -- wiring -------------------------------------------------------------------------------------


def test_the_app_wires_the_agent_only_when_a_provider_is_selected() -> None:
    off = create_app_from_settings(Settings(_env_file=None))
    assert off.state.agent is None

    on = create_app_from_settings(settings())  # constructing makes no network call
    assert on.state.agent is not None


def test_building_the_provider_makes_no_network_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts: list[object] = []
    real = socket.socket.connect

    def spy(self: socket.socket, address: Any) -> None:
        attempts.append(address)
        real(self, address)

    monkeypatch.setattr(socket.socket, "connect", spy)
    create_app_from_settings(settings())
    assert attempts == []


def test_an_invalid_selection_cannot_build_a_model() -> None:
    with pytest.raises(ConfigError):
        build_chat_model(settings(groq_api_key=None))
    with pytest.raises(ConfigError):
        build_chat_model(settings(agent_model=None))


def test_provider_sdk_loggers_cannot_write_payloads_even_with_a_debug_root_logger(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)  # the root logger, as a misconfigured deployment might set it
    transport = Transport((200, completion("ok")))
    world = agent_world(transport)  # building the adapter pins the SDK loggers
    world.send("a distinctive visitor sentence")

    noisy = [r for r in caplog.records if r.name.split(".")[0] in {"groq", "httpx", "httpcore"}]
    assert noisy == []
    assert "a distinctive visitor sentence" not in " ".join(r.getMessage() for r in caplog.records)


def test_the_base_url_is_pinned_and_ignores_ambient_environment_variables(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GROQ_API_BASE", "https://evil.example.invalid/v1")
    monkeypatch.setenv("GROQ_BASE_URL", "https://evil.example.invalid")
    transport = Transport((200, completion()))
    ask(transport)

    url = transport.requests[0].url
    assert (url.scheme, url.host) == ("https", "api.groq.com")


@pytest.mark.parametrize(
    "variable",
    ["LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING"],
)
def test_a_host_that_enables_tracing_fails_startup_naming_only_the_variable(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, variable: str
) -> None:
    monkeypatch.setenv(variable, "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "fake-offline-tracing-credential")
    with pytest.raises(ConfigError):
        build_chat_model(settings(), http_client=Transport().client())

    logged = " ".join(r.getMessage() for r in caplog.records)
    assert variable in logged
    assert "fake-offline-tracing-credential" not in logged


def test_tracing_variables_set_to_false_are_fine() -> None:
    # The offline guard sets them to "false": that must not be refused.
    assert build_chat_model(settings(), http_client=Transport().client()) is not None


def test_the_production_client_also_gets_no_retries_and_the_call_timeout() -> None:
    model = build_chat_model(settings())  # no injected client: the SDK builds its own
    assert model is not None
    sdk_client = model.client._client  # type: ignore[attr-defined]
    assert sdk_client.max_retries == 0
    assert sdk_client.timeout == 8.0
    assert str(sdk_client.base_url).rstrip("/") == "https://api.groq.com"
