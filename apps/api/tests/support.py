"""Shared test helpers. Dates are fixed so results never depend on the real clock."""

from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime, time, timedelta
from itertools import count
from uuid import UUID
from zoneinfo import ZoneInfo

from voice_agent_api.domain.models import (
    Booking,
    Business,
    CatalogSnapshot,
    Money,
    OpeningInterval,
    Service,
    WeeklyHours,
)
from voice_agent_api.infrastructure.in_memory import InMemoryAppointmentBook

# Wednesday 2026-09-30, 08:00 in America/New_York (EDT).
NOW = datetime(2026, 9, 30, 12, 0, tzinfo=UTC)

NEW_YORK = ZoneInfo("America/New_York")

FLAT_REPAIR = Service("flat-repair", "Flat repair", "", timedelta(minutes=30), Money(1500, "USD"))
TUNE_UP = Service("tune-up", "Tune-up", "", timedelta(minutes=90), Money(8500, "USD"))
OVERHAUL = Service("overhaul", "Overhaul", "", timedelta(minutes=240), Money(22000, "USD"))

# Tuesday-Friday split day, Saturday morning, closed Sunday and Monday (as in the seed).
WEEK_HOURS = WeeklyHours(
    intervals=(
        *(
            i
            for weekday in (1, 2, 3, 4)
            for i in (
                OpeningInterval(weekday, time(9, 0), time(13, 0)),
                OpeningInterval(weekday, time(14, 0), time(18, 0)),
            )
        ),
        OpeningInterval(5, time(9, 0), time(14, 0)),
    )
)

# Open on Sundays 01:00-04:00 so DST transitions (which fall on Sundays) are exercised.
SUNDAY_NIGHT_HOURS = WeeklyHours(intervals=(OpeningInterval(6, time(1, 0), time(4, 0)),))


def make_business(
    *, capacity: int = 2, lead: timedelta = timedelta(hours=2), horizon_days: int = 14
) -> Business:
    return Business(
        id="test",
        name="Test Shop",
        tagline="",
        address="",
        phone="",
        timezone=NEW_YORK,
        currency="USD",
        bench_capacity=capacity,
        slot_interval=timedelta(minutes=30),
        min_lead_time=lead,
        booking_horizon=timedelta(days=horizon_days),
    )


def local_booking(service_id: str, day: date, start: time, minutes: int, bench: int = 1) -> Booking:
    start_utc = datetime.combine(day, start).replace(tzinfo=NEW_YORK).astimezone(UTC)
    return Booking(service_id, start_utc, start_utc + timedelta(minutes=minutes), bench)


class MutableCatalog:
    """A catalog whose values can change between a proposal and its confirmation."""

    def __init__(self, business: Business, hours: WeeklyHours, services: list[Service]) -> None:
        self._business = business
        self._hours = hours
        self._services = {s.id: s for s in services}

    def set_business(self, business: Business) -> None:
        self._business = business

    def set_hours(self, hours: WeeklyHours) -> None:
        self._hours = hours

    def set_service(self, service: Service) -> None:
        self._services[service.id] = service

    def remove_service(self, service_id: str) -> None:
        del self._services[service_id]

    def business(self) -> Business:
        return self._business

    def hours(self) -> WeeklyHours:
        return self._hours

    def services(self) -> Sequence[Service]:
        return tuple(self._services.values())

    def service_by_id(self, service_id: str) -> Service | None:
        return self._services.get(service_id)

    def snapshot(self, service_id: str | None = None) -> CatalogSnapshot:
        service = self._services.get(service_id) if service_id is not None else None
        return CatalogSnapshot(self._business, self._hours, service)


# Tuesday 2026-10-06 10:00 America/New_York (EDT) = 14:00 UTC, inside the booking window.
SLOT_START = datetime(2026, 10, 6, 14, 0, tzinfo=UTC)


def make_world(
    bookings: Sequence[Booking] = (),
) -> tuple[MutableCatalog, InMemoryAppointmentBook]:
    catalog = MutableCatalog(make_business(), WEEK_HOURS, [FLAT_REPAIR, TUNE_UP, OVERHAUL])
    return catalog, InMemoryAppointmentBook(catalog, bookings, lambda: NOW)


def id_sequence() -> Callable[[], UUID]:
    """Deterministic proposal ids for tests."""
    counter = count(1)
    return lambda: UUID(int=next(counter))
