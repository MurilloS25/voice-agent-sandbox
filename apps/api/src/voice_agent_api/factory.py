import secrets
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Protocol
from uuid import UUID, uuid4

from fastapi import FastAPI
from starlette.concurrency import run_in_threadpool

from voice_agent_api.agent.orchestrator import AgentService
from voice_agent_api.api.dependencies import Clock
from voice_agent_api.api.errors import register_error_handlers
from voice_agent_api.api.proposal_tokens import ProposalTokenCodec
from voice_agent_api.api.routes import router
from voice_agent_api.config import (
    MIN_SIGNING_KEY_BYTES,
    Settings,
    resolve_signing_key,
)
from voice_agent_api.domain.ports import AppointmentBook, BusinessCatalog
from voice_agent_api.infrastructure.seed import build_seed


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
) -> FastAPI:
    """Build the app from explicit parts. Nothing here connects to anything.

    `agent` is None when no model provider is configured: `POST /v1/agent/turns` then answers 503
    `agent_unavailable` and everything else works as before. A given agent is opened and closed
    with the app's lifespan, like `resources`."""

    # The agent owns a call pool that must be closed at shutdown, so it is always managed here.
    managed: list[Lifecycle] = [*resources]
    if agent is not None and agent not in managed:
        managed.append(agent)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        # Opening and closing a pool blocks, so both go through the worker threadpool.
        opened: list[Lifecycle] = []
        try:
            for resource in managed:
                await run_in_threadpool(resource.open)
                opened.append(resource)
            yield
        finally:
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
    )
    key = signing_key if signing_key is not None else secrets.token_bytes(MIN_SIGNING_KEY_BYTES)
    app.state.catalog = catalog
    app.state.appointments = appointments
    app.state.clock = clock
    app.state.token_codec = ProposalTokenCodec(key)
    app.state.id_factory = id_factory
    app.state.agent = agent
    register_error_handlers(app)
    app.include_router(router)
    return app


def create_app_from_settings(settings: Settings) -> FastAPI:
    key = resolve_signing_key(settings)
    if settings.appointment_store == "postgres":
        # Imported here so memory mode and OpenAPI generation never need a database.
        from voice_agent_api.infrastructure.postgres import build_postgres

        pg_catalog, pg_book, database = build_postgres(settings)
        return create_app(pg_catalog, pg_book, system_clock, signing_key=key, resources=(database,))
    catalog, appointments = build_seed(system_clock(), system_clock)
    return create_app(catalog, appointments, system_clock, signing_key=key)
