"""Shared test helpers. Dates are fixed so results never depend on the real clock."""

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


def local_booking(service_id: str, day: date, start: time, minutes: int) -> Booking:
    start_utc = datetime.combine(day, start).replace(tzinfo=NEW_YORK).astimezone(UTC)
    return Booking(service_id, start_utc, start_utc + timedelta(minutes=minutes))
