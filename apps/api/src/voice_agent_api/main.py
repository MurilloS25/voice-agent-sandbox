from datetime import UTC, datetime

from fastapi import FastAPI

from voice_agent_api.api.dependencies import Clock
from voice_agent_api.api.errors import register_error_handlers
from voice_agent_api.api.routes import router
from voice_agent_api.domain.ports import AppointmentBook, BusinessCatalog
from voice_agent_api.infrastructure.seed import build_seed


def system_clock() -> datetime:
    return datetime.now(UTC)


def create_app(catalog: BusinessCatalog, appointments: AppointmentBook, clock: Clock) -> FastAPI:
    app = FastAPI(
        title="Voice Agent Sandbox API",
        version="0.1.0",
        description="Fictional business data and deterministic availability. Demo data only.",
    )
    app.state.catalog = catalog
    app.state.appointments = appointments
    app.state.clock = clock
    register_error_handlers(app)
    app.include_router(router)
    return app


def _default_app() -> FastAPI:
    catalog, appointments = build_seed(system_clock())
    return create_app(catalog, appointments, system_clock)


app = _default_app()
