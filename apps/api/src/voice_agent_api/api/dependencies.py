"""Dependencies. Everything that reaches a port is a plain `def`, so FastAPI runs it in its
worker threadpool: the Postgres adapter is synchronous and must never run on the event loop."""

from collections.abc import Callable
from datetime import datetime
from typing import Annotated, cast
from uuid import UUID

from fastapi import Depends, Request

from voice_agent_api.agent.discards import DiscardedProposals
from voice_agent_api.agent.orchestrator import AgentService
from voice_agent_api.api.proposal_tokens import ProposalTokenCodec
from voice_agent_api.domain.ports import AppointmentBook, BusinessCatalog
from voice_agent_api.speech.bounded import SpeechService

Clock = Callable[[], datetime]
IdFactory = Callable[[], UUID]


def get_catalog(request: Request) -> BusinessCatalog:
    return cast(BusinessCatalog, request.app.state.catalog)


def get_appointments(request: Request) -> AppointmentBook:
    return cast(AppointmentBook, request.app.state.appointments)


def get_clock(request: Request) -> Clock:
    return cast(Clock, request.app.state.clock)


def get_token_codec(request: Request) -> ProposalTokenCodec:
    return cast(ProposalTokenCodec, request.app.state.token_codec)


def get_discards(request: Request) -> DiscardedProposals:
    return cast(DiscardedProposals, request.app.state.discards)


def get_id_factory(request: Request) -> IdFactory:
    return cast(IdFactory, request.app.state.id_factory)


def get_agent(request: Request) -> AgentService | None:
    """None when no provider is configured: the route answers 503 `agent_unavailable`."""
    return cast(AgentService | None, request.app.state.agent)


def get_speech(request: Request) -> SpeechService | None:
    """None when no speech provider is configured: the route answers 503 `speech_unavailable`."""
    return cast(SpeechService | None, request.app.state.speech)


AgentDep = Annotated[AgentService | None, Depends(get_agent)]
SpeechDep = Annotated[SpeechService | None, Depends(get_speech)]
CatalogDep = Annotated[BusinessCatalog, Depends(get_catalog)]
AppointmentsDep = Annotated[AppointmentBook, Depends(get_appointments)]
ClockDep = Annotated[Clock, Depends(get_clock)]
TokenCodecDep = Annotated[ProposalTokenCodec, Depends(get_token_codec)]
IdFactoryDep = Annotated[IdFactory, Depends(get_id_factory)]
DiscardsDep = Annotated[DiscardedProposals, Depends(get_discards)]
