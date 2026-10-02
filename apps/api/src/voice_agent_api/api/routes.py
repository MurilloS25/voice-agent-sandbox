"""HTTP routes.

Every route that reaches the catalog or the appointment book is a plain `def`, so FastAPI runs
it in the worker threadpool. The Postgres adapter is synchronous; an `async def` route calling
it would block the event loop for every other request. A test enforces this.
"""

import logging
import re
from datetime import date
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Query, Response
from pydantic import BeforeValidator

from voice_agent_api.agent.contracts import AgentTurnRequest, AgentTurnResponse
from voice_agent_api.agent.errors import AgentUnavailable
from voice_agent_api.api.dependencies import (
    AgentDep,
    AppointmentsDep,
    CatalogDep,
    ClockDep,
    IdFactoryDep,
    TokenCodecDep,
)
from voice_agent_api.api.mappers import proposal_response, service_response
from voice_agent_api.api.schemas import (
    AppointmentProposalRequest,
    AppointmentProposalResponse,
    AppointmentResponse,
    AppointmentServiceResponse,
    AvailabilityResponse,
    BookingWindowResponse,
    BusinessResponse,
    ConfirmAppointmentRequest,
    ErrorResponse,
    HealthResponse,
    MoneyResponse,
    OpeningIntervalResponse,
    ServicesResponse,
    SlotResponse,
)
from voice_agent_api.domain.availability import booking_window
from voice_agent_api.domain.commands import confirm_appointment, propose_appointment
from voice_agent_api.domain.errors import AppointmentNotFound
from voice_agent_api.domain.models import Appointment
from voice_agent_api.domain.queries import query_availability

router = APIRouter()
logger = logging.getLogger("voice_agent_api")

_DATE_ONLY = re.compile(r"\d{4}-\d{2}-\d{2}")


def _require_date_only(value: object) -> object:
    """Pydantic's lax date parsing also accepts timestamps; the contract is YYYY-MM-DD only."""
    if not isinstance(value, str) or not _DATE_ONLY.fullmatch(value):
        raise ValueError("Expected a date in YYYY-MM-DD format.")
    return value


DateOnly = Annotated[date, BeforeValidator(_require_date_only)]

_AVAILABILITY_ERRORS: dict[int | str, dict[str, Any]] = {
    404: {"model": ErrorResponse, "description": "Unknown service."},
    422: {"model": ErrorResponse, "description": "Invalid request or date outside the window."},
    503: {"model": ErrorResponse, "description": "Storage unavailable."},
}

_PROPOSAL_ERRORS: dict[int | str, dict[str, Any]] = {
    404: {"model": ErrorResponse, "description": "Unknown service."},
    409: {"model": ErrorResponse, "description": "slot_unavailable: every bench is taken."},
    422: {
        "model": ErrorResponse,
        "description": "validation_error, date_out_of_range or slot_not_offered.",
    },
    503: {"model": ErrorResponse, "description": "Storage unavailable."},
}

_CONFIRM_ERRORS: dict[int | str, dict[str, Any]] = {
    200: {
        "model": AppointmentResponse,
        "description": "The proposal had already been confirmed: the original appointment.",
    },
    409: {
        "model": ErrorResponse,
        "description": "slot_unavailable (just taken) or proposal_stale (details changed).",
    },
    422: {
        "model": ErrorResponse,
        "description": (
            "validation_error, proposal_invalid, proposal_expired, or slot_not_offered "
            "(the time is no longer offered, for example it is now inside the lead time)."
        ),
    },
    503: {"model": ErrorResponse, "description": "Storage unavailable."},
}

_GET_APPOINTMENT_ERRORS: dict[int | str, dict[str, Any]] = {
    404: {"model": ErrorResponse, "description": "Unknown appointment."},
    422: {"model": ErrorResponse, "description": "Invalid appointment id."},
    503: {"model": ErrorResponse, "description": "Storage unavailable."},
}


def _appointment_response(appointment: Appointment) -> AppointmentResponse:
    """Built from the saved row alone, so a replay is identical even if the catalog changed."""
    minutes = int((appointment.end - appointment.start).total_seconds() // 60)
    return AppointmentResponse(
        id=appointment.id,
        status="confirmed" if appointment.status == "confirmed" else "cancelled",
        service=AppointmentServiceResponse(
            id=appointment.service_id,
            name=appointment.service_name,
            duration_minutes=minutes,
            price=MoneyResponse(
                amount_minor=appointment.price.amount_minor,
                currency=appointment.price.currency,
            ),
        ),
        start=appointment.start,
        end=appointment.end,
        timezone=appointment.timezone,
        customer_alias=appointment.customer_alias,
        bench=appointment.bench,
        source=appointment.source,
        created_at=appointment.created_at,
    )


@router.get("/health", response_model=HealthResponse, tags=["system"])
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get(
    "/v1/business",
    response_model=BusinessResponse,
    tags=["business"],
    responses={503: {"model": ErrorResponse, "description": "Storage unavailable."}},
)
def read_business(catalog: CatalogDep, clock: ClockDep) -> BusinessResponse:
    snapshot = catalog.snapshot()
    business = snapshot.business
    window = booking_window(business, clock())
    return BusinessResponse(
        id=business.id,
        name=business.name,
        tagline=business.tagline,
        address=business.address,
        phone=business.phone,
        timezone=business.timezone.key,
        currency=business.currency,
        slot_interval_minutes=int(business.slot_interval.total_seconds() // 60),
        hours=[
            OpeningIntervalResponse(
                weekday=i.weekday,
                start=i.start.strftime("%H:%M"),
                end=i.end.strftime("%H:%M"),
            )
            for i in snapshot.hours.intervals
        ],
        booking_window=BookingWindowResponse(
            first_date=window.first_date, last_date=window.last_date
        ),
    )


@router.get(
    "/v1/services",
    response_model=ServicesResponse,
    tags=["business"],
    responses={503: {"model": ErrorResponse, "description": "Storage unavailable."}},
)
def list_services(catalog: CatalogDep) -> ServicesResponse:
    return ServicesResponse(services=[service_response(s) for s in catalog.services()])


@router.get(
    "/v1/services/{service_id}/availability",
    response_model=AvailabilityResponse,
    tags=["availability"],
    responses=_AVAILABILITY_ERRORS,
)
def read_availability(
    service_id: str,
    day: Annotated[
        DateOnly,
        Query(alias="date", description="Local date in the business timezone (YYYY-MM-DD)."),
    ],
    appointments: AppointmentsDep,
    clock: ClockDep,
) -> AvailabilityResponse:
    result = query_availability(appointments, service_id, day, clock())
    return AvailabilityResponse(
        service_id=service_id,
        date=day,
        timezone=result.timezone,
        slots=[SlotResponse(start=s.start, end=s.end) for s in result.slots],
    )


@router.post(
    "/v1/appointment-proposals",
    response_model=AppointmentProposalResponse,
    tags=["appointments"],
    responses=_PROPOSAL_ERRORS,
)
def create_appointment_proposal(
    body: AppointmentProposalRequest,
    appointments: AppointmentsDep,
    clock: ClockDep,
    codec: TokenCodecDep,
    new_id: IdFactoryDep,
) -> AppointmentProposalResponse:
    """Describe what booking this slot would do. Nothing is saved."""
    review = propose_appointment(appointments, body.service_id, body.start, clock(), new_id)
    return proposal_response(review, codec.encode(review.proposal))


@router.post(
    "/v1/appointments",
    response_model=AppointmentResponse,
    status_code=201,
    tags=["appointments"],
    responses=_CONFIRM_ERRORS,
)
def confirm_appointment_route(
    body: ConfirmAppointmentRequest,
    response: Response,
    appointments: AppointmentsDep,
    clock: ClockDep,
    codec: TokenCodecDep,
) -> AppointmentResponse:
    """The only write. Requires a valid proposal token and an explicit `confirm: true`."""
    proposal = codec.decode(body.proposal_token)
    appointment, created = confirm_appointment(appointments, proposal, clock())
    if not created:
        response.status_code = 200
    # Audit trail: the sanitized outcome only. Never an identifier (the appointment's included),
    # the token, the alias or any submitted value (ADR 0007, "Identifier taxonomy").
    logger.info("appointment_confirm outcome=%s", "created" if created else "replayed")
    return _appointment_response(appointment)


def _retry_after(description: str) -> dict[str, Any]:
    return {
        "Retry-After": {
            "description": description,
            "schema": {"type": "integer"},
        }
    }


_AGENT_TURN_ERRORS: dict[int | str, dict[str, Any]] = {
    404: {"model": ErrorResponse, "description": "conversation_not_found."},
    409: {
        "model": ErrorResponse,
        "description": (
            "idempotency_key_reused, turn_in_progress, conversation_busy, turn_out_of_order "
            "or conversation_limit_reached. Nothing was accepted. `turn_in_progress` and "
            "`conversation_busy` send Retry-After."
        ),
        "headers": _retry_after("Seconds to wait before retrying (turn_in_progress, busy)."),
    },
    410: {"model": ErrorResponse, "description": "conversation_expired."},
    422: {"model": ErrorResponse, "description": "validation_error."},
    429: {
        "model": ErrorResponse,
        "description": "agent_busy.",
        "headers": _retry_after("Seconds to wait before retrying."),
    },
    503: {"model": ErrorResponse, "description": "agent_unavailable: no provider is configured."},
}


@router.post(
    "/v1/agent/turns",
    response_model=AgentTurnResponse,
    tags=["agent"],
    responses=_AGENT_TURN_ERRORS,
)
def create_agent_turn(body: AgentTurnRequest, agent: AgentDep) -> AgentTurnResponse:
    """One conversational turn. Idempotent per `client_turn_id` while the API process retains
    the conversation. The assistant can only read and prepare a review; it cannot book."""
    if agent is None:
        raise AgentUnavailable
    return agent.handle_turn(body)


@router.get(
    "/v1/appointments/{appointment_id}",
    response_model=AppointmentResponse,
    tags=["appointments"],
    responses=_GET_APPOINTMENT_ERRORS,
)
def read_appointment(appointment_id: UUID, appointments: AppointmentsDep) -> AppointmentResponse:
    appointment = appointments.get(appointment_id)
    if appointment is None:
        raise AppointmentNotFound
    return _appointment_response(appointment)
