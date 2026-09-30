"""Transport schemas. Kept separate from domain types so the wire format is explicit."""

import datetime as dt
from typing import Literal

from pydantic import BaseModel, Field


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


class ErrorFieldDetail(BaseModel):
    loc: list[str] = Field(description="Location of the invalid field.")
    issue: str = Field(description="Machine-readable validation issue type.")


class ErrorBody(BaseModel):
    code: str
    message: str
    details: list[ErrorFieldDetail] | None = None


class ErrorResponse(BaseModel):
    error: ErrorBody
