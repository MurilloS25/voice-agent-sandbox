"""The hand-written LangGraph for one turn: `agent` (one bounded model call) and `tools` (the
allow-listed executor). No checkpointer and no `interrupt()`: the human confirmation lives in
the existing signed-proposal flow, outside this graph.

Failures inside nodes never raise out of the graph. They record an event and set
`state["degraded"]`, which routes to the end, so the orchestrator always finishes the turn and
commits exactly one response.
"""

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from functools import partial
from typing import Any, Literal

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    InvalidToolCall,
    SystemMessage,
    ToolCall,
    ToolMessage,
)
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from pydantic import ValidationError

from voice_agent_api.agent.bounded import BoundedCaller, CallTimedOut, Deadline, DeadlineExceeded
from voice_agent_api.agent.events import EventLog, sanitize_model_text
from voice_agent_api.agent.limits import AgentLimits
from voice_agent_api.agent.providers import classify_provider_error
from voice_agent_api.agent.state import AgentState, TurnWorkspace
from voice_agent_api.agent.tools import (
    TOOLS,
    ToolExecutor,
    ToolOutcome,
    issue_codes,
    parse_tool_args,
    tool_input_for_event,
    tool_specs,
)

logger = logging.getLogger("voice_agent_api")


@dataclass(frozen=True)
class GraphDeps:
    model: BaseChatModel
    tools: ToolExecutor
    caller: BoundedCaller
    deadline: Deadline
    limits: AgentLimits
    workspace: TurnWorkspace
    events: EventLog
    system_prompt: str
    clock: Callable[[], datetime]


def _message_text(message: AIMessage) -> str:
    content = message.content
    if isinstance(content, str):
        return content
    parts = [
        block if isinstance(block, str) else str(block.get("text", ""))
        for block in content
        if isinstance(block, str) or block.get("type") == "text"
    ]
    return "".join(parts)


_REASONING_KEYS = frozenset({"reasoning_content", "reasoning"})


def _without_reasoning(message: AIMessage) -> AIMessage:
    """Drop provider reasoning fields, so they are never replayed to the model or shown."""
    kept = {k: v for k, v in message.additional_kwargs.items() if k not in _REASONING_KEYS}
    if len(kept) == len(message.additional_kwargs):
        return message
    return message.model_copy(update={"additional_kwargs": kept})


def _normalize_tool_calls(message: AIMessage, cap: int) -> tuple[AIMessage, bool]:
    """Give every call an id (so each gets a paired ToolMessage) and keep at most `cap` calls
    per model message, valid ones first. Returns the message and whether calls were dropped, so a
    model cannot grow a turn's events by emitting hundreds of calls."""
    valid = [
        ToolCall(**{**c, "id": c.get("id") or f"call_{i}"})
        for i, c in enumerate(message.tool_calls)
    ]
    invalid = [
        InvalidToolCall(**{**c, "id": c.get("id") or f"invalid_{i}"})
        for i, c in enumerate(message.invalid_tool_calls)
    ]
    kept_valid = valid[:cap]
    kept_invalid = invalid[: max(cap - len(kept_valid), 0)]
    truncated = len(kept_valid) + len(kept_invalid) < len(valid) + len(invalid)
    normalized = message.model_copy(
        update={"tool_calls": kept_valid, "invalid_tool_calls": kept_invalid}
    )
    return normalized, truncated


def _reject_tool_call(call_id: str, code: str) -> ToolMessage:
    return ToolMessage(content=f'{{"status":"rejected","code":"{code}"}}', tool_call_id=call_id)


def build_graph(deps: GraphDeps) -> CompiledStateGraph[Any, Any, Any, Any]:
    limits, workspace, events = deps.limits, deps.workspace, deps.events
    bound = deps.model.bind_tools(tool_specs(), tool_choice="auto")

    def agent_node(state: AgentState) -> dict[str, Any]:
        if state["model_calls"] >= limits.max_model_calls:
            events.guardrail("model_call_budget_exceeded")
            return {"degraded": "model_call_budget_exceeded"}
        prompt = [SystemMessage(content=deps.system_prompt), *state["messages"]]
        update: dict[str, Any] = {"model_calls": state["model_calls"] + 1}
        try:
            response = deps.caller.call(
                lambda: bound.invoke(prompt),
                limit_s=limits.model_timeout_s,
                deadline=deps.deadline,
                min_start_s=limits.min_call_start_s,
            )
        except DeadlineExceeded:
            events.turn_error("turn_deadline_exceeded")
            return {**update, "degraded": "turn_deadline_exceeded"}
        except CallTimedOut:
            events.provider_error("model_timeout")
            return {**update, "degraded": "model_timeout"}
        except Exception as exc:
            code = classify_provider_error(exc)
            logger.warning("agent_model_error error=%s", type(exc).__name__)
            events.provider_error(code)
            return {**update, "degraded": code}

        if not isinstance(response, AIMessage):
            events.provider_error("model_bad_output")
            return {**update, "degraded": "model_bad_output"}
        usage = response.usage_metadata
        if usage:
            workspace.input_tokens += int(usage.get("input_tokens", 0))
            workspace.output_tokens += int(usage.get("output_tokens", 0))
        response, truncated = _normalize_tool_calls(
            _without_reasoning(response), limits.max_tool_calls
        )
        if truncated:
            events.guardrail("tool_budget_exceeded")
        update["messages"] = [response]
        if response.tool_calls or response.invalid_tool_calls:
            return update
        text = sanitize_model_text(_message_text(response), limits.max_reply_chars)
        if not text:
            events.provider_error("model_bad_output")
            return {**update, "degraded": "model_bad_output"}
        return {**update, "reply_text": text}

    def tools_node(state: AgentState) -> dict[str, Any]:
        last = state["messages"][-1]
        assert isinstance(last, AIMessage)
        results: list[ToolMessage] = []
        executed = state["tool_calls"]
        if any(call["name"] == "find_available_slots" for call in last.tool_calls) or any(
            call.get("name") == "find_available_slots" for call in last.invalid_tool_calls
        ):
            workspace.search_attempted = True  # before any call in this message runs

        for index, invalid in enumerate(last.invalid_tool_calls):
            call_id = invalid.get("id") or f"invalid_{index}"
            events.guardrail("invalid_tool_input", tool=None, issues=["arguments:unparseable"])
            results.append(_reject_tool_call(call_id, "invalid_tool_input"))

        for index, call in enumerate(last.tool_calls):
            call_id = call.get("id") or f"call_{index}"
            name = call["name"]
            if name not in TOOLS:
                # The model-chosen name is never echoed into events.
                events.guardrail("tool_not_allowed")
                results.append(_reject_tool_call(call_id, "tool_not_allowed"))
                continue
            over_budget = executed >= limits.max_tool_calls or (
                name == "prepare_booking_review" and workspace.review is not None
            )
            if over_budget:
                events.guardrail("tool_budget_exceeded", tool=name)
                results.append(_reject_tool_call(call_id, "tool_budget_exceeded"))
                continue
            try:
                args = parse_tool_args(name, call["args"])
            except ValidationError as error:
                events.guardrail("invalid_tool_input", tool=name, issues=issue_codes(name, error))
                results.append(_reject_tool_call(call_id, "invalid_tool_input"))
                continue

            events.tool_requested(name, tool_input_for_event(args))
            executed += 1
            started = time.monotonic()
            now = deps.clock()
            offered = workspace.reviewable  # never this turn's own search results
            searched = workspace.search_attempted or workspace.offered_changed
            try:
                outcome: ToolOutcome = deps.caller.call(
                    # Arguments are bound now: an abandoned call sees only these values.
                    partial(deps.tools.run, name, args, offered, now, searched),
                    limit_s=limits.tool_timeout_s,
                    deadline=deps.deadline,
                    min_start_s=limits.min_call_start_s,
                )
            except DeadlineExceeded:
                events.turn_error("turn_deadline_exceeded")
                return {
                    "messages": results,
                    "tool_calls": executed,
                    "degraded": "turn_deadline_exceeded",
                }
            except CallTimedOut:
                outcome = ToolOutcome(
                    "error",
                    "tool_timeout",
                    "The tool took too long.",
                    '{"status":"error","code":"tool_timeout"}',
                )
            except Exception as exc:
                logger.warning("agent_tool_error tool=%s error=%s", name, type(exc).__name__)
                outcome = ToolOutcome(
                    "error",
                    "tool_error",
                    "The tool failed.",
                    '{"status":"error","code":"tool_error"}',
                )

            duration_ms = int((time.monotonic() - started) * 1000)
            events.tool_result(name, outcome.status, duration_ms, outcome.summary, outcome.code)
            if outcome.offered is not None:
                workspace.offered = outcome.offered
                workspace.offered_changed = True
            if outcome.review is not None:
                workspace.review = outcome.review
                pending = outcome.review.pending
                events.booking_review_ready(
                    service_name=pending.service_name,
                    local_date=pending.local_date,
                    local_start=pending.local_start,
                    local_end=pending.local_end,
                    timezone=pending.timezone,
                    price_display=pending.price_display,
                )
            results.append(ToolMessage(content=outcome.content, tool_call_id=call_id))
        return {"messages": results, "tool_calls": executed}

    def after_agent(state: AgentState) -> Literal["tools", "__end__"]:
        if state["degraded"] is not None or state["reply_text"] is not None:
            return "__end__"
        return "tools"

    def after_tools(state: AgentState) -> Literal["agent", "__end__"]:
        return "__end__" if state["degraded"] is not None else "agent"

    graph = StateGraph(AgentState)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", tools_node)
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", after_agent, {"tools": "tools", "__end__": END})
    graph.add_conditional_edges("tools", after_tools, {"agent": "agent", "__end__": END})
    return graph.compile()
