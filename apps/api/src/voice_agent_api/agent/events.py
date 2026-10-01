"""Builds the structured timeline. Events carry only sanitized values: user text, the assistant's
visible text, validated tool inputs, fixed codes and short summaries composed by this code.
Never a token, an identifier, exception text or model reasoning."""

import re
from collections.abc import Callable
from datetime import datetime
from typing import Literal

from voice_agent_api.agent.contracts import (
    AssistantMessageEvent,
    BookingReviewReadyEvent,
    GuardrailEvent,
    ProviderErrorEvent,
    SystemMessageEvent,
    TimelineEvent,
    ToolInput,
    ToolRequestedEvent,
    ToolResultEvent,
    TurnErrorEvent,
    UserMessageEvent,
)

GuardrailCode = Literal[
    "tool_not_allowed",
    "invalid_tool_input",
    "tool_budget_exceeded",
    "model_call_budget_exceeded",
]
ProviderCode = Literal[
    "model_timeout", "model_rate_limited", "model_unavailable", "model_bad_output"
]
TurnErrorCode = Literal["turn_deadline_exceeded", "storage_unavailable", "internal_error"]
ToolStatus = Literal["ok", "rejected", "error"]

_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_THINK_OPEN = re.compile(r"<think>.*", re.DOTALL | re.IGNORECASE)
_CONTROL = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]")
# Defense in depth: the model never sees a proposal token, so it cannot repeat one.
_TOKEN_SHAPE = re.compile(r"v1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")


def sanitize_model_text(text: str, limit: int) -> str:
    """Visible assistant text: no reasoning blocks, control characters or token-shaped strings."""
    text = _THINK_BLOCK.sub("", text)
    text = _THINK_OPEN.sub("", text)
    text = _CONTROL.sub("", text)
    text = _TOKEN_SHAPE.sub("[removed]", text)
    return text.strip()[:limit]


class EventLog:
    """Collects one turn's events in order, numbering them from 1."""

    def __init__(self, clock: Callable[[], datetime]) -> None:
        self._clock = clock
        self._events: list[TimelineEvent] = []

    @property
    def events(self) -> list[TimelineEvent]:
        return list(self._events)

    def _next(self) -> tuple[int, datetime]:
        return len(self._events) + 1, self._clock()

    def user_message(self, text: str) -> None:
        seq, at = self._next()
        self._events.append(
            UserMessageEvent(seq=seq, at=at, kind="user_message", actor="user", text=text)
        )

    def tool_requested(self, tool: str, tool_input: ToolInput) -> None:
        seq, at = self._next()
        self._events.append(
            ToolRequestedEvent(
                seq=seq,
                at=at,
                kind="tool_requested",
                actor="assistant",
                tool=tool,
                input=tool_input,
            )
        )

    def tool_result(
        self,
        tool: str,
        status: ToolStatus,
        duration_ms: int,
        summary: str,
        code: str | None = None,
    ) -> None:
        seq, at = self._next()
        self._events.append(
            ToolResultEvent(
                seq=seq,
                at=at,
                kind="tool_result",
                actor="tool",
                tool=tool,
                status=status,
                duration_ms=duration_ms,
                summary=summary,
                code=code,
            )
        )

    def booking_review_ready(
        self,
        *,
        service_name: str,
        local_date: str,
        local_start: str,
        local_end: str,
        timezone: str,
        price_display: str,
    ) -> None:
        seq, at = self._next()
        self._events.append(
            BookingReviewReadyEvent(
                seq=seq,
                at=at,
                kind="booking_review_ready",
                actor="tool",
                service_name=service_name,
                local_date=local_date,
                local_start=local_start,
                local_end=local_end,
                timezone=timezone,
                price_display=price_display,
            )
        )

    def assistant_message(self, text: str) -> None:
        seq, at = self._next()
        self._events.append(
            AssistantMessageEvent(
                seq=seq, at=at, kind="assistant_message", actor="assistant", text=text
            )
        )

    def system_message(self, text: str) -> None:
        seq, at = self._next()
        self._events.append(
            SystemMessageEvent(seq=seq, at=at, kind="system_message", actor="system", text=text)
        )

    def guardrail(
        self, code: GuardrailCode, tool: str | None = None, issues: list[str] | None = None
    ) -> None:
        seq, at = self._next()
        self._events.append(
            GuardrailEvent(
                seq=seq,
                at=at,
                kind="guardrail",
                actor="system",
                code=code,
                tool=tool,
                issues=issues or [],
            )
        )

    def provider_error(self, code: ProviderCode) -> None:
        seq, at = self._next()
        self._events.append(
            ProviderErrorEvent(seq=seq, at=at, kind="provider_error", actor="system", code=code)
        )

    def turn_error(self, code: TurnErrorCode) -> None:
        seq, at = self._next()
        self._events.append(
            TurnErrorEvent(seq=seq, at=at, kind="turn_error", actor="system", code=code)
        )
