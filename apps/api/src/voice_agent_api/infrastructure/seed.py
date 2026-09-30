"""Fictional seed data for Quillwheel Cycle Works.

Nothing here describes a real business or person.
"""

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from voice_agent_api.domain.models import (
    Booking,
    Business,
    Money,
    OpeningInterval,
    Service,
    WeeklyHours,
)
from voice_agent_api.infrastructure.in_memory import InMemoryAppointmentBook, InMemoryCatalog

CURRENCY = "USD"

BUSINESS = Business(
    id="quillwheel",
    name="Quillwheel Cycle Works",
    tagline="Honest repairs for everyday bikes.",
    address="14 Lantern Lane, Juniper Crossing, NY",
    phone="+1 212-555-0142",
    timezone=ZoneInfo("America/New_York"),
    currency=CURRENCY,
    bench_capacity=2,
    slot_interval=timedelta(minutes=30),
    min_lead_time=timedelta(hours=2),
    booking_horizon=timedelta(days=14),
)

_TUE, _WED, _THU, _FRI, _SAT = 1, 2, 3, 4, 5

HOURS = WeeklyHours(
    intervals=(
        *(
            interval
            for weekday in (_TUE, _WED, _THU, _FRI)
            for interval in (
                OpeningInterval(weekday, time(9, 0), time(13, 0)),
                OpeningInterval(weekday, time(14, 0), time(18, 0)),
            )
        ),
        OpeningInterval(_SAT, time(9, 0), time(14, 0)),
    )
)

SERVICES = (
    Service(
        id="flat-repair",
        name="Flat repair",
        description="Patch or replace a punctured tube and check the tire.",
        duration=timedelta(minutes=30),
        price=Money(1500, CURRENCY),
    ),
    Service(
        id="brake-adjustment",
        name="Brake adjustment",
        description="Center, tighten, and test rim or disc brakes.",
        duration=timedelta(minutes=45),
        price=Money(3500, CURRENCY),
    ),
    Service(
        id="wheel-truing",
        name="Wheel truing",
        description="Straighten a wobbling wheel and set spoke tension.",
        duration=timedelta(minutes=60),
        price=Money(4000, CURRENCY),
    ),
    Service(
        id="standard-tune-up",
        name="Standard tune-up",
        description="Brakes, gears, chain, and bolts checked and adjusted.",
        duration=timedelta(minutes=90),
        price=Money(8500, CURRENCY),
    ),
    Service(
        id="full-overhaul",
        name="Full overhaul",
        description="Strip, clean, regrease, and rebuild the whole bike.",
        duration=timedelta(minutes=240),
        price=Money(22000, CURRENCY),
    ),
)


def _next_open_dates(hours: WeeklyHours, after: date, count: int) -> list[date]:
    dates: list[date] = []
    cursor = after
    while len(dates) < count:
        cursor += timedelta(days=1)
        if hours.for_weekday(cursor.weekday()):
            dates.append(cursor)
    return dates


def _booking(service_id: str, local_date: date, start: time, minutes: int) -> Booking:
    local_start = datetime.combine(local_date, start).replace(tzinfo=BUSINESS.timezone)
    start_utc = local_start.astimezone(UTC)
    return Booking(service_id, start_utc, start_utc + timedelta(minutes=minutes))


def seed_bookings(now: datetime) -> list[Booking]:
    """Fictional existing bookings on the next two open days, so availability shows gaps."""
    today = now.astimezone(BUSINESS.timezone).date()
    first, second = _next_open_dates(HOURS, today, 2)
    return [
        # First open day: both benches busy 10:00-11:30, one bench busy 14:00-14:45.
        _booking("standard-tune-up", first, time(10, 0), 90),
        _booking("standard-tune-up", first, time(10, 0), 90),
        _booking("brake-adjustment", first, time(14, 0), 45),
        # Second open day: one bench busy all morning.
        _booking("full-overhaul", second, time(9, 0), 240),
    ]


def build_seed(now: datetime) -> tuple[InMemoryCatalog, InMemoryAppointmentBook]:
    return (
        InMemoryCatalog(BUSINESS, HOURS, SERVICES),
        InMemoryAppointmentBook(seed_bookings(now)),
    )
