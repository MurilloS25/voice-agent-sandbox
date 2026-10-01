"""Offline helpers for agent tests: a scripted chat model and a ready-made world.

No network, no key and no `.env`: every model reply comes from the script.
"""

import secrets
import threading
from collections.abc import Callable, Iterator, Sequence
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import PrivateAttr

from tests.support import NOW, id_sequence, make_world
from voice_agent_api.agent.contracts import AgentTurnRequest, AgentTurnResponse
from voice_agent_api.agent.limits import AgentLimits
from voice_agent_api.agent.orchestrator import AgentService
from voice_agent_api.agent.store import InMemoryConversationStore
from voice_agent_api.api.proposal_tokens import ProposalTokenCodec
from voice_agent_api.domain.models import Booking
from voice_agent_api.infrastructure.in_memory import InMemoryAppointmentBook

KEY = secrets.token_bytes(32)
SLOT_DATE = "2026-10-06"  # a Tuesday inside the booking window of `NOW`

Step = AIMessage | Exception | Callable[[list[BaseMessage]], AIMessage | Exception]


def say(text: str) -> AIMessage:
    return AIMessage(content=text)


def blocked_until(
    release: threading.Event, reply: AIMessage, finished: threading.Event | None = None
) -> Step:
    """A model step that waits for `release` (like a stuck provider call), then answers.
    `finished` is set once the abandoned call has returned its late answer."""

    def step(_: list[BaseMessage]) -> AIMessage:
        release.wait(10)
        if finished is not None:
            finished.set()
        return reply

    return step


def call_tools(*calls: tuple[str, dict[str, Any]]) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {"name": name, "args": args, "id": f"call_{index}", "type": "tool_call"}
            for index, (name, args) in enumerate(calls, start=1)
        ],
    )


class ScriptedChatModel(BaseChatModel):
    """Replays a script. `bind_tools` returns the model itself and records what was offered."""

    _steps: list[Step] = PrivateAttr(default_factory=list)
    _calls: list[list[BaseMessage]] = PrivateAttr(default_factory=list)
    _bound: list[Any] = PrivateAttr(default_factory=list)
    _lock: threading.Lock = PrivateAttr(default_factory=threading.Lock)

    def __init__(self, steps: Sequence[Step] = (), **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._steps = list(steps)

    def add_steps(self, *steps: Step) -> None:
        with self._lock:
            self._steps.extend(steps)

    @property
    def calls(self) -> list[list[BaseMessage]]:
        with self._lock:
            return list(self._calls)

    @property
    def bound_tools(self) -> list[Any]:
        return list(self._bound)

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ScriptedChatModel":
        self._bound.append(tools)
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        with self._lock:
            self._calls.append(list(messages))
            if not self._steps:
                raise AssertionError("The scripted model ran out of steps.")
            step = self._steps.pop(0)
        result = step(list(messages)) if callable(step) else step
        if isinstance(result, Exception):
            raise result
        return ChatResult(generations=[ChatGeneration(message=result)])


class AgentWorld:
    """A fixed-clock world with an in-memory book, a signing key and a scripted model."""

    def __init__(
        self,
        steps: Sequence[Step] = (),
        *,
        limits: AgentLimits | None = None,
        bookings: Sequence[Booking] = (),
        store: InMemoryConversationStore | None = None,
        wrap_book: Callable[[InMemoryAppointmentBook], Any] | None = None,
        wrap_catalog: Callable[[Any], Any] | None = None,
        chat_model: BaseChatModel | None = None,
    ) -> None:
        catalog, self.book = make_world(bookings)
        self.catalog = wrap_catalog(catalog) if wrap_catalog else catalog
        self.wrapped_book = wrap_book(self.book) if wrap_book else self.book
        self.model = ScriptedChatModel(steps)
        self.codec = ProposalTokenCodec(KEY)
        self.store = store or InMemoryConversationStore(lambda: NOW)
        self.service = AgentService(
            store=self.store,
            model=chat_model or self.model,
            catalog=self.catalog,
            appointments=self.wrapped_book,
            new_id=id_sequence(),
            encode=self.codec.encode,
            clock=lambda: NOW,
            limits=limits or AgentLimits(),
        )
        self.conversation_id = uuid4()
        self.turn_index = 0

    def request(
        self,
        message: str,
        *,
        turn_index: int | None = None,
        client_turn_id: UUID | None = None,
        conversation_id: UUID | None = None,
    ) -> AgentTurnRequest:
        return AgentTurnRequest(
            conversation_id=conversation_id or self.conversation_id,
            client_turn_id=client_turn_id or uuid4(),
            turn_index=turn_index if turn_index is not None else self.turn_index + 1,
            message=message,
        )

    def send(self, message: str) -> AgentTurnResponse:
        """The next turn of the conversation."""
        response = self.service.handle_turn(self.request(message))
        self.turn_index = response.turn_index
        return response

    def stored_bookings(self) -> int:
        return len(
            self.book.bookings_overlapping(
                datetime(2026, 1, 1, tzinfo=NOW.tzinfo), datetime(2027, 1, 1, tzinfo=NOW.tzinfo)
            )
        )


class GateBook:
    """Delegates to a real book. While `block` is set, `day_view` waits for `release`, like a slow
    database call that cannot be cancelled. `fail` makes it raise instead."""

    def __init__(self, inner: InMemoryAppointmentBook) -> None:
        self.inner = inner
        self.block = False
        self.fail: Exception | None = None
        self.release = threading.Event()
        self.entered = threading.Event()
        self.finished = threading.Event()  # set when a blocked call has finished late

    def day_view(self, service_id: str, when: Any) -> Any:
        if self.fail is not None:
            raise self.fail
        if self.block:
            self.entered.set()
            self.release.wait(10)
            result = self.inner.day_view(service_id, when)
            self.finished.set()
            return result
        return self.inner.day_view(service_id, when)

    def bookings_overlapping(self, start: Any, end: Any) -> Any:
        return self.inner.bookings_overlapping(start, end)

    def confirm(self, proposal: Any, decide: Any) -> Any:
        return self.inner.confirm(proposal, decide)

    def get(self, appointment_id: Any) -> Any:
        return self.inner.get(appointment_id)


class FailingCatalog:
    """Delegates to a catalog, but `snapshot` raises while `fail` is set."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.fail: Exception | None = None

    def snapshot(self, service_id: str | None = None) -> Any:
        if self.fail is not None:
            raise self.fail
        return self.inner.snapshot(service_id)

    def business(self) -> Any:
        return self.inner.business()

    def hours(self) -> Any:
        return self.inner.hours()

    def services(self) -> Any:
        return self.inner.services()

    def service_by_id(self, service_id: str) -> Any:
        return self.inner.service_by_id(service_id)


def kinds(response: AgentTurnResponse) -> list[str]:
    return [event.kind for event in response.events]


def tool_names(response: AgentTurnResponse) -> list[str]:
    return [event.tool for event in response.events if event.kind == "tool_requested"]


def iter_text(response: AgentTurnResponse) -> Iterator[str]:
    """Every string in the response except the authorized `booking_review` payload."""
    yield response.reply.text
    for event in response.events:
        yield event.model_dump_json()
