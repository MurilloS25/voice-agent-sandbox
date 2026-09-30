"""Appointment-domain types. Pure data: no FastAPI or Pydantic imports."""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
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
    """An existing appointment occupying one bench. Times are timezone-aware UTC."""

    service_id: str
    start: datetime
    end: datetime


@dataclass(frozen=True)
class Slot:
    start: datetime
    end: datetime


@dataclass(frozen=True)
class BookingWindow:
    """Inclusive range of bookable local dates."""

    first_date: date
    last_date: date
