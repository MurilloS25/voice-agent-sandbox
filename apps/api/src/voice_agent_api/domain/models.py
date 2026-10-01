"""Appointment-domain types. Pure data: no FastAPI or Pydantic imports."""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class Money:
    amount_minor: int
    currency: str


@dataclass(frozen=True)
class Business:
    id: str
    name: str
    tagline: str
    address: str
    phone: str
    timezone: ZoneInfo
    currency: str
    bench_capacity: int
    slot_interval: timedelta
    min_lead_time: timedelta
    booking_horizon: timedelta


@dataclass(frozen=True)
class Service:
    id: str
    name: str
    description: str
    duration: timedelta
    price: Money


@dataclass(frozen=True)
class OpeningInterval:
    """A local-time opening interval. `weekday` follows `date.weekday()` (Monday = 0)."""

    weekday: int
    start: time
    end: time


@dataclass(frozen=True)
class WeeklyHours:
    intervals: tuple[OpeningInterval, ...]

    def for_weekday(self, weekday: int) -> tuple[OpeningInterval, ...]:
        return tuple(i for i in self.intervals if i.weekday == weekday)


@dataclass(frozen=True)
class Booking:
    """An existing appointment occupying one bench. Times are timezone-aware UTC.

    Intervals are half-open: [start, end). A booking that ends exactly when another starts
    does not overlap it.
    """

    service_id: str
    start: datetime
    end: datetime
    bench: int


@dataclass(frozen=True)
class Slot:
    start: datetime
    end: datetime


@dataclass(frozen=True)
class BookingWindow:
    """Inclusive range of bookable local dates."""

    first_date: date
    last_date: date


@dataclass(frozen=True)
class CatalogSnapshot:
    """A fresh read of everything a booking depends on. `service` is None when it is gone."""

    business: Business
    hours: WeeklyHours
    service: Service | None


@dataclass(frozen=True)
class Proposal:
    """What a verified proposal token asserts: four inputs plus a comparison fingerprint.

    The fingerprint is only compared against a freshly computed one; it never supplies a value
    to the appointment.
    """

    id: UUID
    service_id: str
    start: datetime
    expires_at: datetime
    fingerprint: str


@dataclass(frozen=True)
class ProposalReview:
    """A proposal plus the server-computed values the user reviews. Not stored in the token."""

    proposal: Proposal
    service: Service
    timezone: str
    end: datetime
    customer_alias: str


@dataclass(frozen=True)
class NewAppointment:
    """Every value of an appointment, recomputed server-side from the current catalog."""

    business_id: str
    service_id: str
    bench: int
    start: datetime
    end: datetime
    customer_alias: str
    source: str
    proposal_id: UUID
    # A snapshot of what was booked, so the saved record never changes if the catalog does.
    service_name: str
    price: Money
    timezone: str


@dataclass(frozen=True)
class Appointment:
    id: UUID
    business_id: str
    service_id: str
    bench: int
    start: datetime
    end: datetime
    status: str
    customer_alias: str
    source: str
    proposal_id: UUID | None
    created_at: datetime
    updated_at: datetime
    # Snapshot of the booked service name, price and the business timezone at booking time.
    service_name: str
    price: Money
    timezone: str
