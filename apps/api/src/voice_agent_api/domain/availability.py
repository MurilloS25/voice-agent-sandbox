"""Deterministic availability rules. Pure functions; `now` is always injected.

Time rules:
- Opening hours are local wall-clock times in the business timezone.
- Slots are returned as timezone-aware UTC datetimes.
- DST: a local slot start that does not exist (spring-forward gap) is skipped. An ambiguous
  local time (fall-back) resolves to its first occurrence (`fold=0`), so no slot is duplicated.
"""

from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from voice_agent_api.domain.errors import DateOutsideBookingWindow, SlotNotOffered, SlotUnavailable
from voice_agent_api.domain.models import (
    Booking,
    BookingWindow,
    Business,
    Service,
    Slot,
    WeeklyHours,
)


def booking_window(business: Business, now: datetime) -> BookingWindow:
    today = now.astimezone(business.timezone).date()
    return BookingWindow(first_date=today, last_date=today + business.booking_horizon)


def _local_to_utc(local_naive: datetime, tz: ZoneInfo) -> datetime:
    return local_naive.replace(tzinfo=tz).astimezone(UTC)


def _exists_locally(local_naive: datetime, tz: ZoneInfo) -> bool:
    """False when the wall-clock time falls in a spring-forward gap."""
    round_trip = _local_to_utc(local_naive, tz).astimezone(tz).replace(tzinfo=None)
    return round_trip == local_naive


def available_slots(
    business: Business,
    hours: WeeklyHours,
    service: Service,
    local_date: date,
    bookings: Sequence[Booking],
    now: datetime,
) -> list[Slot]:
    window = booking_window(business, now)
    if not window.first_date <= local_date <= window.last_date:
        raise DateOutsideBookingWindow(local_date, window.first_date, window.last_date)

    tz = business.timezone
    earliest_start = now + business.min_lead_time
    slots: list[Slot] = []

    for interval in sorted(hours.for_weekday(local_date.weekday()), key=lambda i: i.start):
        cursor = datetime.combine(local_date, interval.start)
        interval_end = _local_to_utc(datetime.combine(local_date, interval.end), tz)

        while True:
            if _exists_locally(cursor, tz):
                start = _local_to_utc(cursor, tz)
                end = start + service.duration
                if end > interval_end:
                    break
                if start >= earliest_start and free_bench(business, bookings, start, end):
                    slots.append(Slot(start=start, end=end))
            elif _local_to_utc(cursor, tz) + service.duration > interval_end:
                break
            cursor += business.slot_interval

    return sorted(slots, key=lambda s: s.start)


def free_bench(
    business: Business, bookings: Sequence[Booking], start: datetime, end: datetime
) -> int | None:
    """The lowest-numbered bench with no booking overlapping [start, end), or None.

    Each appointment holds one bench for its whole duration, so a job fits only when a single
    bench is free throughout. Intervals are half-open: a booking ending exactly at `start`
    does not block it.
    """
    busy = {b.bench for b in bookings if b.start < end and b.end > start}
    return next((n for n in range(1, business.bench_capacity + 1) if n not in busy), None)


def local_day_of(business: Business, when: date | datetime) -> date:
    """The business-local calendar day of a local date, or of an instant."""
    if isinstance(when, datetime):  # check first: datetime is a subclass of date
        return when.astimezone(business.timezone).date()
    return when


def local_day_bounds(business: Business, local_date: date) -> tuple[datetime, datetime]:
    """The UTC instants bounding a business-local calendar day, as [start, end)."""
    tz = business.timezone
    day_start = datetime.combine(local_date, datetime.min.time()).replace(tzinfo=tz)
    day_end = datetime.combine(local_date + timedelta(days=1), datetime.min.time()).replace(
        tzinfo=tz
    )
    return day_start.astimezone(UTC), day_end.astimezone(UTC)


def check_slot(
    business: Business,
    hours: WeeklyHours,
    service: Service,
    start: datetime,
    bookings: Sequence[Booking],
    now: datetime,
) -> int:
    """Return the bench a booking at `start` would use, or raise.

    `SlotNotOffered`: the start is not a slot at all (grid, hours, lead time, DST gap).
    `SlotUnavailable`: it is a normal slot but no bench is free for the whole job.
    `DateOutsideBookingWindow` is raised for dates beyond the booking window.
    """
    start_utc = start.astimezone(UTC)
    local_date = start_utc.astimezone(business.timezone).date()
    offered = available_slots(business, hours, service, local_date, (), now)
    if start_utc not in {slot.start for slot in offered}:
        raise SlotNotOffered
    bench = free_bench(business, bookings, start_utc, start_utc + service.duration)
    if bench is None:
        raise SlotUnavailable
    return bench
