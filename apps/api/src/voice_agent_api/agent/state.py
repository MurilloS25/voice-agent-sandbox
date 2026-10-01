"""Agent state: what a conversation remembers and what one graph run carries.

A conversation keeps only user and assistant text, the slots the server last offered, and a
summary of the pending review (display values, never the token). Structured tool results are
not replayed to the model on later turns: the system prompt is rebuilt each turn from this state.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Literal, TypedDict

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages

from voice_agent_api.api.schemas import AppointmentProposalResponse


@dataclass(frozen=True)
class OfferedSlot:
    """A slot the server offered. The model can only select one by its `slot_id`."""

    slot_id: str
    service_id: str
    service_name: str
    start: datetime
    local_date: str
    weekday: str
    local_start: str
    local_end: str


@dataclass(frozen=True)
class PendingReview:
    service_name: str
    local_date: str
    local_start: str
    local_end: str
    timezone: str
    price_display: str
    expires_at: datetime


@dataclass(frozen=True)
class PreparedReview:
    """A review the tool prepared: the wire payload (it holds the opaque token) and its summary."""

    wire: AppointmentProposalResponse
    pending: PendingReview


@dataclass(frozen=True)
class HistoryEntry:
    role: Literal["user", "assistant"]
    text: str


@dataclass(frozen=True)
class ConversationSnapshot:
    """An immutable copy of committed conversation state, handed to a turn."""

    history: tuple[HistoryEntry, ...] = ()
    offered: tuple[OfferedSlot, ...] = ()
    pending_review: PendingReview | None = None
    committed_turns: int = 0


@dataclass(frozen=True)
class ConversationUpdate:
    """What a completed turn changes. `None` means unchanged."""

    history_append: tuple[HistoryEntry, ...]
    offered: tuple[OfferedSlot, ...] | None = None
    pending_review: PendingReview | None = None


class AgentState(TypedDict):
    """LangGraph state for one turn. Events, offered slots and the review live in the turn's
    workspace, so a failure inside the graph cannot lose them."""

    messages: Annotated[list[AnyMessage], add_messages]
    model_calls: int
    tool_calls: int
    degraded: str | None
    reply_text: str | None


@dataclass
class TurnWorkspace:
    """Mutable working copy for one accepted turn. Only the turn's own thread touches it;
    abandoned calls never receive it."""

    offered: tuple[OfferedSlot, ...]
    offered_changed: bool = False
    review: PreparedReview | None = None
    input_tokens: int = 0
    output_tokens: int = 0
