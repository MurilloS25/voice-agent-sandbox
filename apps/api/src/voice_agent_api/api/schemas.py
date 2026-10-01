"""Transport schemas. Kept separate from domain types so the wire format is explicit."""

import datetime as dt
import uuid
from typing import Literal

from pydantic import AwareDatetime, BaseModel, Field, field_validator


class HealthResponse(BaseModel):
    status: Literal["ok"]


class MoneyResponse(BaseModel):
    amount_minor: int = Field(description="Amount in the currency's minor unit (e.g. cents).")
    currency: str = Field(description="ISO 4217 currency code.")


class OpeningIntervalResponse(BaseModel):
    weekday: int = Field(ge=0, le=6, description="0 = Monday ... 6 = Sunday.")
    start: str = Field(pattern=r"^\d{2}:\d{2}$", description="Local opening time, HH:MM.")
    end: str = Field(pattern=r"^\d{2}:\d{2}$", description="Local closing time, HH:MM.")


class BookingWindowResponse(BaseModel):
    first_date: dt.date = Field(description="First bookable date in the business timezone.")
    last_date: dt.date = Field(description="Last bookable date in the business timezone.")


class BusinessResponse(BaseModel):
    id: str
    name: str
    tagline: str
    address: str
    phone: str
    timezone: str = Field(description="IANA timezone of the business.")
    currency: str
    slot_interval_minutes: int
    hours: list[OpeningIntervalResponse]
    booking_window: BookingWindowResponse


class ServiceResponse(BaseModel):
    id: str
    name: str
    description: str
    duration_minutes: int
    price: MoneyResponse


class ServicesResponse(BaseModel):
    services: list[ServiceResponse]


class SlotResponse(BaseModel):
    start: dt.datetime = Field(description="Slot start, UTC.")
    end: dt.datetime = Field(description="Slot end, UTC.")


class AvailabilityResponse(BaseModel):
    service_id: str
    date: dt.date = Field(description="The requested date, interpreted in the business timezone.")
    timezone: str
    slots: list[SlotResponse]


class AppointmentProposalRequest(BaseModel):
    service_id: str = Field(min_length=1, max_length=64)
    start: AwareDatetime = Field(description="Requested slot start. Must include a UTC offset.")


class AppointmentProposalResponse(BaseModel):
    """What confirming would book. Nothing has been saved yet."""

    proposal_token: str = Field(description="Signed, short-lived. Send it back to confirm.")
    expires_at: dt.datetime
    service: ServiceResponse
    start: dt.datetime = Field(description="Start, UTC.")
    end: dt.datetime = Field(description="End, UTC. Computed by the server.")
    timezone: str
    customer_alias: str = Field(description="Fictional demo name the server assigned.")


class ConfirmAppointmentRequest(BaseModel):
    proposal_token: str = Field(min_length=1, max_length=2048)
    confirm: Literal[True] = Field(description="Must be true: the user explicitly confirmed.")

    @field_validator("confirm", mode="before")
    @classmethod
    def _boolean_true_only(cls, value: object) -> object:
        # Pydantic's lax literal matching would also accept the number 1.
        if value is not True:
            raise ValueError("Expected the boolean true.")
        return value


class AppointmentServiceResponse(BaseModel):
    """The service as it was when the appointment was booked (a saved snapshot)."""

    id: str
    name: str
    duration_minutes: int
    price: MoneyResponse


class AppointmentResponse(BaseModel):
    """What the schedule service confirmed and saved. Rendered from the saved row only."""

    id: uuid.UUID
    status: Literal["confirmed", "cancelled"]
    service: AppointmentServiceResponse
    start: dt.datetime = Field(description="Start, UTC.")
    end: dt.datetime = Field(description="End, UTC.")
    timezone: str
    customer_alias: str
    bench: int
    source: str
    created_at: dt.datetime


class ErrorFieldDetail(BaseModel):
    loc: list[str] = Field(description="Location of the invalid field.")
    issue: str = Field(description="Machine-readable validation issue type.")


class ErrorBody(BaseModel):
    code: str
    message: str
    details: list[ErrorFieldDetail] | None = None


class ErrorResponse(BaseModel):
    error: ErrorBody
