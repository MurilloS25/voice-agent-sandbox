"""Deterministic availability rules. Pure functions; `now` is always injected.

Time rules:
- Opening hours are local wall-clock times in the business timezone.
- Slots are returned as timezone-aware UTC datetimes.
- DST: a local slot start that does not exist (spring-forward gap) is skipped. An ambiguous
  local time (fall-back) resolves to its first occurrence (`fold=0`), so no slot is duplicated.
"""

from collections.abc import Sequence
from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from voice_agent_api.domain.errors import DateOutsideBookingWindow
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
                if start >= earliest_start and _has_free_bench(business, bookings, start, end):
                    slots.append(Slot(start=start, end=end))
            elif _local_to_utc(cursor, tz) + service.duration > interval_end:
                break
            cursor += business.slot_interval

    return sorted(slots, key=lambda s: s.start)


def _has_free_bench(
    business: Business, bookings: Sequence[Booking], start: datetime, end: datetime
) -> bool:
    """True when a bench stays free for the whole of [start, end).

    Uses peak concurrency, not the count of overlapping bookings: two back-to-back bookings
    that each overlap the candidate only ever occupy one bench at a time. Concurrency can
    only peak at the candidate's start or at a booking start inside it.
    """
    overlapping = [b for b in bookings if b.start < end and b.end > start]
    checkpoints = [start, *(b.start for b in overlapping if b.start > start)]
    peak = max(sum(1 for b in overlapping if b.start <= t < b.end) for t in checkpoints)
    return peak < business.bench_capacity
