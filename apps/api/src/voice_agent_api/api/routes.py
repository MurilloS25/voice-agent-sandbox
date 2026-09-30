import re
from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BeforeValidator

from voice_agent_api.api.dependencies import AppointmentsDep, CatalogDep, ClockDep
from voice_agent_api.api.schemas import (
    AvailabilityResponse,
    BookingWindowResponse,
    BusinessResponse,
    ErrorResponse,
    HealthResponse,
    MoneyResponse,
    OpeningIntervalResponse,
    ServiceResponse,
    ServicesResponse,
    SlotResponse,
)
from voice_agent_api.domain.availability import booking_window
from voice_agent_api.domain.models import Service
from voice_agent_api.domain.queries import get_availability

router = APIRouter()

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
}


def _service_response(service: Service) -> ServiceResponse:
    return ServiceResponse(
        id=service.id,
        name=service.name,
        description=service.description,
        duration_minutes=int(service.duration.total_seconds() // 60),
        price=MoneyResponse(
            amount_minor=service.price.amount_minor, currency=service.price.currency
        ),
    )


@router.get("/health", response_model=HealthResponse, tags=["system"])
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get("/v1/business", response_model=BusinessResponse, tags=["business"])
def read_business(catalog: CatalogDep, clock: ClockDep) -> BusinessResponse:
    business = catalog.business()
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
            for i in catalog.hours().intervals
        ],
        booking_window=BookingWindowResponse(
            first_date=window.first_date, last_date=window.last_date
        ),
    )


@router.get("/v1/services", response_model=ServicesResponse, tags=["business"])
def list_services(catalog: CatalogDep) -> ServicesResponse:
    return ServicesResponse(services=[_service_response(s) for s in catalog.services()])


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
    catalog: CatalogDep,
    appointments: AppointmentsDep,
    clock: ClockDep,
) -> AvailabilityResponse:
    slots = get_availability(catalog, appointments, service_id, day, clock())
    return AvailabilityResponse(
        service_id=service_id,
        date=day,
        timezone=catalog.business().timezone.key,
        slots=[SlotResponse(start=s.start, end=s.end) for s in slots],
    )
