import secrets
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Protocol
from uuid import UUID, uuid4

from fastapi import FastAPI
from starlette.concurrency import run_in_threadpool

from voice_agent_api.agent.discards import DiscardedProposals
from voice_agent_api.agent.limits import AgentLimits
from voice_agent_api.agent.orchestrator import AgentService
from voice_agent_api.agent.providers import build_chat_model
from voice_agent_api.agent.store import InMemoryConversationStore
from voice_agent_api.api.dependencies import Clock
from voice_agent_api.api.errors import register_error_handlers
from voice_agent_api.api.proposal_tokens import ProposalTokenCodec
from voice_agent_api.api.routes import router
from voice_agent_api.api.speech_routes import router as speech_router
from voice_agent_api.budget.guard import BudgetGuard
from voice_agent_api.budget.ledger import InMemoryBudgetLedger
from voice_agent_api.config import (
    MIN_SIGNING_KEY_BYTES,
    Settings,
    resolve_signing_key,
)
from voice_agent_api.domain.ports import AppointmentBook, BusinessCatalog
from voice_agent_api.infrastructure.seed import build_seed
from voice_agent_api.security.build import build_protection
from voice_agent_api.security.middleware import Protection, ProtectionMiddleware
from voice_agent_api.speech.bounded import SpeechService
from voice_agent_api.speech.limits import SpeechLimits
from voice_agent_api.speech.providers import build_speech_to_text


class Lifecycle(Protocol):
    """A blocking resource (a connection pool) opened at startup and closed at shutdown."""

    def open(self) -> None: ...

    def close(self) -> None: ...


def system_clock() -> datetime:
    return datetime.now(UTC)


def create_app(
    catalog: BusinessCatalog,
    appointments: AppointmentBook,
    clock: Clock,
    *,
    signing_key: bytes | None = None,
    id_factory: Callable[[], UUID] = uuid4,
    resources: Sequence[Lifecycle] = (),
    agent: AgentService | None = None,
    speech: SpeechService | None = None,
    protection: Protection | None = None,
    docs_enabled: bool = True,
    ready_check: Callable[[], bool] | None = None,
    log_tracebacks: bool = False,
) -> FastAPI:
    """Build the app from explicit parts. Nothing here connects to anything.

    `agent` is None when no model provider is configured: `POST /v1/agent/turns` then answers 503
    `agent_unavailable` and everything else works as before. A given agent is opened and closed
    with the app's lifespan, like `resources`. `speech` works the same way: None means
    `POST /v1/speech/transcriptions` answers 503 `speech_unavailable`.

    `protection` adds the trust boundary (authentication, rate limits, body limits, a last-resort
    error handler); without it the app behaves as before, which is what most unit tests want.
    `docs_enabled=False` removes the interactive docs and the schema (production). `ready_check`
    is what `GET /health/ready` asks (for example the database)."""

    # The agent and the speech service own call pools that must be closed at shutdown, so they
    # are always managed here.
    managed: list[Lifecycle] = [*resources]
    if agent is not None and agent not in managed:
        managed.append(agent)
    if speech is not None and speech not in managed:
        managed.append(speech)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Opening and closing a pool blocks, so both go through the worker threadpool.
        opened: list[Lifecycle] = []
        try:
            for resource in managed:
                await run_in_threadpool(resource.open)
                opened.append(resource)
            app.state.draining = False
            yield
        finally:
            # Draining first: readiness turns false and no new costly request is accepted while
            # the pools close.
            app.state.draining = True
            for resource in reversed(opened):
                await run_in_threadpool(resource.close)

    app = FastAPI(
        title="Voice Agent Sandbox API",
        version="0.1.0",
        description=(
            "Fictional business data, deterministic availability, and explicit-confirmation "
            "booking. Demo data only."
        ),
        lifespan=lifespan,
        docs_url="/docs" if docs_enabled else None,
        redoc_url="/redoc" if docs_enabled else None,
        openapi_url="/openapi.json" if docs_enabled else None,
    )
    key = signing_key if signing_key is not None else secrets.token_bytes(MIN_SIGNING_KEY_BYTES)
    app.state.catalog = catalog
    app.state.appointments = appointments
    app.state.clock = clock
    app.state.token_codec = ProposalTokenCodec(key)
    app.state.id_factory = id_factory
    app.state.agent = agent
    # Reviews the visitor withdrew (empty when there is no agent): consulted when confirming.
    app.state.discards = agent.discards if agent is not None else DiscardedProposals()
    app.state.speech = speech
    app.state.draining = False
    app.state.ready_check = ready_check
    app.state.log_tracebacks = log_tracebacks
    register_error_handlers(app)
    app.include_router(router)
    app.include_router(speech_router)
    if protection is not None:
        # Added last, so it is outermost among the app's own layers: it sees every request first.
        app.add_middleware(ProtectionMiddleware, protection=protection)
    return app


def build_agent(
    settings: Settings,
    catalog: BusinessCatalog,
    appointments: AppointmentBook,
    key: bytes,
    budget: BudgetGuard | None = None,
) -> AgentService | None:
    """The agent for the configured provider, or None when it is disabled (the default).
    Construction makes no network call."""
    model = build_chat_model(settings)
    if model is None:
        return None
    return AgentService(
        store=InMemoryConversationStore(system_clock),
        model=model,
        catalog=catalog,
        appointments=appointments,
        new_id=uuid4,
        encode=ProposalTokenCodec(key).encode,
        clock=system_clock,
        limits=AgentLimits.from_settings(settings),
        budget=budget,
    )


def build_speech(settings: Settings, budget: BudgetGuard | None = None) -> SpeechService | None:
    """The speech service for the configured provider, or None when it is disabled (the default).
    Construction makes no network call."""
    port = build_speech_to_text(settings)
    if port is None:
        return None
    return SpeechService(port, SpeechLimits.from_settings(settings), budget)


def create_app_from_settings(settings: Settings) -> FastAPI:
    key = resolve_signing_key(settings)
    if settings.appointment_store == "postgres":
        # Imported here so memory mode and OpenAPI generation never need a database.
        from voice_agent_api.infrastructure.postgres import PostgresBudgetLedger, build_postgres

        # `database` is not opened until the app starts, so a failure while building the agent
        # (a ConfigError, already ruled out by validation) leaves nothing connected.
        pg_catalog, pg_book, database = build_postgres(settings)
        budget = (
            BudgetGuard.from_settings(PostgresBudgetLedger(database), system_clock, settings)
            if settings.budget_enforced
            else None
        )
        return create_app(
            pg_catalog,
            pg_book,
            system_clock,
            signing_key=key,
            resources=(database,),
            agent=build_agent(settings, pg_catalog, pg_book, key, budget),
            speech=build_speech(settings, budget),
            protection=build_protection(settings),
            docs_enabled=settings.app_env != "production",
            ready_check=database.ping,
            log_tracebacks=settings.log_tracebacks,
        )
    catalog, appointments = build_seed(system_clock(), system_clock)
    # In memory the ledger is in memory too (local development and rehearsals): same rules, and
    # production never gets here with a provider enabled (configuration refuses it).
    budget = (
        BudgetGuard.from_settings(InMemoryBudgetLedger(), system_clock, settings)
        if settings.budget_enforced
        else None
    )
    return create_app(
        catalog,
        appointments,
        system_clock,
        signing_key=key,
        agent=build_agent(settings, catalog, appointments, key, budget),
        speech=build_speech(settings, budget),
        protection=build_protection(settings),
        docs_enabled=settings.app_env != "production",
        log_tracebacks=settings.log_tracebacks,
    )
