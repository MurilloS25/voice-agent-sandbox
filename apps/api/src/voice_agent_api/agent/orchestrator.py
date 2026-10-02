"""One accepted turn, end to end.

`handle_turn` asks the store to accept or replay the turn, runs the graph on a working copy, and
commits exactly one `AgentTurnResponse` (completed or degraded) atomically. Once a turn is
accepted the API answers 200 and the exact response is cached, so a retry never calls the model
again. A failure to commit releases the in-flight marker, so markers never leak.

A review prepared during a turn that then degrades is returned explicitly (rule A in the plan):
the visitor is never left with a hidden pending review, and never receives a
`booking_review_ready` event without the matching `booking_review`.
"""

import logging
import threading
import time
from collections.abc import Callable
from datetime import datetime
from uuid import UUID

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage

from voice_agent_api.agent.bounded import BoundedCaller, CallTimedOut, Deadline, DeadlineExceeded
from voice_agent_api.agent.contracts import AgentReply, AgentTurnRequest, AgentTurnResponse
from voice_agent_api.agent.errors import AgentBusy
from voice_agent_api.agent.events import EventLog
from voice_agent_api.agent.graph import GraphDeps, build_graph
from voice_agent_api.agent.limits import AgentLimits
from voice_agent_api.agent.prompts import build_system_prompt
from voice_agent_api.agent.readonly import ReadOnlyAppointmentBook
from voice_agent_api.agent.state import (
    ConversationUpdate,
    HistoryEntry,
    TurnWorkspace,
)
from voice_agent_api.agent.store import Accepted, Cached, ConversationStore
from voice_agent_api.agent.tools import ToolExecutor, read_prompt_facts
from voice_agent_api.budget.guard import BudgetGuard, Reservation
from voice_agent_api.domain.errors import StorageUnavailable
from voice_agent_api.domain.models import Proposal
from voice_agent_api.domain.ports import AppointmentBook, BusinessCatalog

logger = logging.getLogger("voice_agent_api")

REVIEW_NOTICE = (
    "I prepared the booking review below, but couldn't finish my reply. "
    "Nothing is booked until you press Confirm booking."
)
_FORM = "or use the booking form."
_DEGRADED_TEXT = {
    "model_timeout": f"The assistant took too long to answer. Please try again, {_FORM}",
    "model_rate_limited": f"The assistant is busy right now. Please try again shortly, {_FORM}",
    "model_unavailable": f"The assistant couldn't answer just now. Please try again, {_FORM}",
    "model_bad_output": f"The assistant couldn't answer just now. Please try again, {_FORM}",
    "turn_deadline_exceeded": f"That took too long. Please try again, {_FORM}",
    "model_call_budget_exceeded": f"I couldn't finish that request. Please rephrase it, {_FORM}",
    "storage_unavailable": "The schedule service is temporarily unavailable. Nothing was booked.",
    "internal_error": f"Something went wrong. Nothing was booked. Please try again, {_FORM}",
}


class AgentCommitFailed(RuntimeError):
    """The store refused to commit an accepted turn (a bug). The marker is released first."""

    def __init__(self) -> None:
        super().__init__("The turn could not be recorded.")


class AgentService:
    def __init__(
        self,
        *,
        store: ConversationStore,
        model: BaseChatModel,
        catalog: BusinessCatalog,
        appointments: AppointmentBook,
        new_id: Callable[[], UUID],
        encode: Callable[[Proposal], str],
        clock: Callable[[], datetime],
        limits: AgentLimits | None = None,
        caller: BoundedCaller | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        budget: BudgetGuard | None = None,
    ) -> None:
        self._budget = budget
        self._limits = limits or AgentLimits()
        self._store = store
        self._model = model
        self._catalog = catalog
        # The agent only ever holds a read-only view: writing raises at runtime.
        self._book = ReadOnlyAppointmentBook(appointments)
        self._clock = clock
        self._monotonic = monotonic
        self._caller = caller or BoundedCaller()
        self._tools = ToolExecutor(catalog, self._book, new_id, encode, self._limits)
        self._gate = threading.BoundedSemaphore(self._limits.max_in_flight_turns)

    # `Lifecycle` (factory.py)
    def open(self) -> None:
        self._caller.open()

    def close(self) -> None:
        self._caller.close()
        clear = getattr(self._store, "clear", None)
        if callable(clear):
            clear()  # nothing a visitor said outlives the process

    def handle_turn(self, request: AgentTurnRequest) -> AgentTurnResponse:
        decision = self._store.begin_turn(request)
        if isinstance(decision, Cached):
            return decision.response
        if not self._gate.acquire(blocking=False):
            self._store.abort_turn(decision.conversation_id, decision.turn_token)
            raise AgentBusy
        committed = False
        try:
            # Money first: the day's allowance is reserved before anything costly happens. A
            # refusal (or a budget that cannot be checked) is raised here, the turn is released
            # below and nothing was spent.
            reservation = self._budget.reserve_agent_turn() if self._budget is not None else None
            started = self._monotonic()
            response, update, stats = self._run_turn(request, decision)
            if self._budget is not None and reservation is not None:
                self._settle(reservation, stats)
            committed = self._store.commit_turn(
                decision.conversation_id, decision.turn_token, response, update
            )
            if not committed:
                raise AgentCommitFailed
            # Counts only: no message text and no identifiers.
            logger.info(
                "agent_turn outcome=%s model_calls=%d tool_calls=%d input_tokens=%d "
                "output_tokens=%d duration_ms=%d",
                response.outcome,
                stats.model_calls,
                stats.tool_calls,
                stats.input_tokens,
                stats.output_tokens,
                int((self._monotonic() - started) * 1000),
            )
            return response
        finally:
            if not committed:
                self._store.abort_turn(decision.conversation_id, decision.turn_token)
            self._gate.release()

    def _settle(self, reservation: Reservation, stats: "_Stats") -> None:
        if self._budget is None:
            return
        if stats.provider_untouched:
            self._budget.refund(reservation)  # the model was never contacted
            return
        used = stats.input_tokens + stats.output_tokens
        if used > 0:
            self._budget.settle(reservation, used)
        # No usage reported: the provider may have counted the call, so the reservation stays.

    # -----------------------------------------------------------------------------------------

    def _run_turn(
        self, request: AgentTurnRequest, accepted: Accepted
    ) -> tuple[AgentTurnResponse, ConversationUpdate, "_Stats"]:
        events = EventLog(self._clock)
        events.user_message(request.message)
        workspace = TurnWorkspace(
            reviewable=accepted.snapshot.offered, offered=accepted.snapshot.offered
        )
        stats = _Stats()
        limits = self._limits
        deadline = Deadline.after(limits.turn_deadline_s, self._monotonic)
        degraded: str | None = None
        reply_text: str | None = None

        try:
            now = self._clock()
            facts = self._caller.call(
                lambda: read_prompt_facts(self._catalog, now),
                limit_s=limits.tool_timeout_s,
                deadline=deadline,
                min_start_s=limits.min_call_start_s,
            )
        except DeadlineExceeded:
            events.turn_error("turn_deadline_exceeded")
            degraded = "turn_deadline_exceeded"
            stats.provider_untouched = True
        except (StorageUnavailable, CallTimedOut):
            events.turn_error("storage_unavailable")
            degraded = "storage_unavailable"
            stats.provider_untouched = True
        except Exception as exc:
            logger.warning("agent_turn_error stage=prompt error=%s", type(exc).__name__)
            events.turn_error("internal_error")
            degraded = "internal_error"
            stats.provider_untouched = True
        else:
            snapshot = accepted.snapshot
            try:
                prompt = build_system_prompt(facts, now, snapshot.offered, snapshot.pending_review)
                history: list[AnyMessage] = [
                    HumanMessage(content=e.text) if e.role == "user" else AIMessage(content=e.text)
                    for e in snapshot.history[-limits.history_messages :]
                ]
                deps = GraphDeps(
                    model=self._model,
                    tools=self._tools,
                    caller=self._caller,
                    deadline=deadline,
                    limits=limits,
                    workspace=workspace,
                    events=events,
                    system_prompt=prompt,
                    clock=self._clock,
                )
                final = build_graph(deps).invoke(
                    {
                        "messages": [*history, HumanMessage(content=request.message)],
                        "model_calls": 0,
                        "tool_calls": 0,
                        "degraded": None,
                        "reply_text": None,
                    },
                    config={"recursion_limit": limits.recursion_limit},
                )
                degraded, reply_text = final["degraded"], final["reply_text"]
                stats.model_calls, stats.tool_calls = final["model_calls"], final["tool_calls"]
            except Exception as exc:
                logger.warning("agent_turn_error stage=graph error=%s", type(exc).__name__)
                events.turn_error("internal_error")
                degraded = "internal_error"
        stats.input_tokens, stats.output_tokens = workspace.input_tokens, workspace.output_tokens

        try:
            response, update = self._compose(request, events, workspace, degraded, reply_text)
        except Exception as exc:
            # A bug while building the response (its error text could carry the review token) must
            # not become a 500 or be logged with detail: degrade, without a review.
            logger.warning("agent_turn_error stage=compose error=%s", type(exc).__name__)
            response, update = self._fallback(request)
        return response, update, stats

    def _compose(
        self,
        request: AgentTurnRequest,
        events: EventLog,
        workspace: TurnWorkspace,
        degraded: str | None,
        reply_text: str | None,
    ) -> tuple[AgentTurnResponse, ConversationUpdate]:
        review = workspace.review
        if degraded is None and reply_text is not None:
            events.assistant_message(reply_text)
            reply = AgentReply(source="assistant", text=reply_text)
        else:
            if degraded is None:
                events.turn_error("internal_error")
                degraded = "internal_error"
            text = REVIEW_NOTICE if review is not None else _DEGRADED_TEXT[degraded]
            events.system_message(text)
            reply = AgentReply(source="system", text=text)

        response = AgentTurnResponse(
            conversation_id=request.conversation_id,
            client_turn_id=request.client_turn_id,
            turn_index=request.turn_index,
            outcome="completed" if reply.source == "assistant" else "degraded",
            reply=reply,
            events=events.events,
            booking_review=review.wire if review is not None else None,
        )
        appended = [HistoryEntry("user", request.message)]
        if reply.source == "assistant":
            appended.append(HistoryEntry("assistant", reply.text))
        update = ConversationUpdate(
            history_append=tuple(appended),
            # Slots become reviewable only when the visitor was actually shown them: a degraded
            # turn (a system notice, not the assistant's answer) promotes nothing.
            offered=workspace.offered
            if workspace.offered_changed and reply.source == "assistant"
            else None,
            pending_review=review.pending if review is not None else None,
        )
        return response, update

    def _fallback(self, request: AgentTurnRequest) -> tuple[AgentTurnResponse, ConversationUpdate]:
        events = EventLog(self._clock)
        events.user_message(request.message)
        events.turn_error("internal_error")
        text = _DEGRADED_TEXT["internal_error"]
        events.system_message(text)
        response = AgentTurnResponse(
            conversation_id=request.conversation_id,
            client_turn_id=request.client_turn_id,
            turn_index=request.turn_index,
            outcome="degraded",
            reply=AgentReply(source="system", text=text),
            events=events.events,
            booking_review=None,
        )
        return response, ConversationUpdate(history_append=(HistoryEntry("user", request.message),))


class _Stats:
    def __init__(self) -> None:
        self.model_calls = 0
        self.tool_calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        # True when the turn ended before any model call could have been made.
        self.provider_untouched = False
