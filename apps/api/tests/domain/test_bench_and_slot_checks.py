from datetime import UTC, date, datetime, time, timedelta

import pytest

from tests.support import (
    FLAT_REPAIR,
    NEW_YORK,
    NOW,
    SLOT_START,
    TUNE_UP,
    WEEK_HOURS,
    local_booking,
    make_business,
)
from voice_agent_api.domain.availability import check_slot, free_bench, local_day_bounds
from voice_agent_api.domain.errors import DateOutsideBookingWindow, SlotNotOffered, SlotUnavailable
from voice_agent_api.domain.models import Booking

BUSINESS = make_business()
TUESDAY = date(2026, 10, 6)


def utc(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, 6, hour, minute, tzinfo=UTC)


def booking(start: datetime, end: datetime, bench: int) -> Booking:
    return Booking("x", start, end, bench)


def test_free_bench_returns_the_lowest_free_bench() -> None:
    assert free_bench(BUSINESS, [], utc(14), utc(15)) == 1
    assert free_bench(BUSINESS, [booking(utc(14), utc(15), 1)], utc(14), utc(15)) == 2
    assert free_bench(BUSINESS, [booking(utc(14), utc(15), 2)], utc(14), utc(15)) == 1


def test_free_bench_is_none_when_every_bench_overlaps() -> None:
    both = [booking(utc(14), utc(15), 1), booking(utc(14, 30), utc(15, 30), 2)]
    assert free_bench(BUSINESS, both, utc(14, 45), utc(15, 15)) is None


def test_intervals_are_half_open() -> None:
    # A booking that ends exactly at the start, or starts exactly at the end, does not overlap.
    before = booking(utc(13), utc(14), 1)
    after = booking(utc(15), utc(16), 1)
    assert free_bench(BUSINESS, [before, after], utc(14), utc(15)) == 1
    # One minute of overlap on either side does.
    assert free_bench(BUSINESS, [booking(utc(13), utc(14, 1), 1)], utc(14), utc(15)) == 2
    assert free_bench(BUSINESS, [booking(utc(14, 59), utc(16), 1)], utc(14), utc(15)) == 2


def test_a_job_needs_one_bench_free_for_its_whole_duration() -> None:
    # Bench 1 is busy the first half, bench 2 the second half: neither is free throughout.
    split = [booking(utc(14), utc(14, 30), 1), booking(utc(14, 30), utc(15), 2)]
    assert free_bench(BUSINESS, split, utc(14), utc(15)) is None


def test_local_day_bounds_follow_the_business_timezone() -> None:
    start, end = local_day_bounds(BUSINESS, TUESDAY)
    assert start == datetime(2026, 10, 6, 4, 0, tzinfo=UTC)  # midnight EDT
    assert end == datetime(2026, 10, 7, 4, 0, tzinfo=UTC)


def test_local_day_bounds_on_a_dst_change_day_are_25_or_23_hours() -> None:
    start, end = local_day_bounds(BUSINESS, date(2026, 11, 1))  # fall back
    assert end - start == timedelta(hours=25)
    start, end = local_day_bounds(BUSINESS, date(2027, 3, 14))  # spring forward
    assert end - start == timedelta(hours=23)


def test_check_slot_returns_the_bench() -> None:
    assert check_slot(BUSINESS, WEEK_HOURS, FLAT_REPAIR, SLOT_START, [], NOW) == 1
    taken = [local_booking("x", TUESDAY, time(10, 0), 30, bench=1)]
    assert check_slot(BUSINESS, WEEK_HOURS, FLAT_REPAIR, SLOT_START, taken, NOW) == 2


@pytest.mark.parametrize(
    "start",
    [
        datetime(2026, 10, 6, 14, 15, tzinfo=UTC),  # off the 30-minute grid
        datetime(2026, 10, 6, 8, 0, tzinfo=UTC),  # 04:00 local, before opening
        datetime(2026, 10, 5, 14, 0, tzinfo=UTC),  # Monday, closed
        datetime(2026, 10, 6, 17, 0, tzinfo=UTC),  # 13:00 local, lunch break
    ],
)
def test_check_slot_rejects_starts_that_are_never_offered(start: datetime) -> None:
    with pytest.raises(SlotNotOffered):
        check_slot(BUSINESS, WEEK_HOURS, FLAT_REPAIR, start, [], NOW)


def test_check_slot_rejects_a_job_that_would_overrun_the_interval() -> None:
    # 90 minutes starting 12:00 local would end at 13:30, past the 13:00 lunch break.
    with pytest.raises(SlotNotOffered):
        check_slot(BUSINESS, WEEK_HOURS, TUNE_UP, datetime(2026, 10, 6, 16, 0, tzinfo=UTC), [], NOW)


def test_check_slot_enforces_lead_time() -> None:
    # NOW is 08:00 local and the lead time is two hours, so 09:00 is too soon.
    today_nine = datetime(2026, 9, 30, 13, 0, tzinfo=UTC)
    with pytest.raises(SlotNotOffered):
        check_slot(BUSINESS, WEEK_HOURS, FLAT_REPAIR, today_nine, [], NOW)


def test_check_slot_distinguishes_unavailable_from_not_offered() -> None:
    both = [
        local_booking("x", TUESDAY, time(10, 0), 30, bench=1),
        local_booking("y", TUESDAY, time(10, 0), 30, bench=2),
    ]
    with pytest.raises(SlotUnavailable):
        check_slot(BUSINESS, WEEK_HOURS, FLAT_REPAIR, SLOT_START, both, NOW)


def test_check_slot_rejects_dates_outside_the_window() -> None:
    far = datetime(2026, 10, 20, 14, 0, tzinfo=UTC)
    with pytest.raises(DateOutsideBookingWindow):
        check_slot(BUSINESS, WEEK_HOURS, FLAT_REPAIR, far, [], NOW)


def test_check_slot_accepts_any_utc_offset_for_the_same_instant() -> None:
    same_instant = SLOT_START.astimezone(NEW_YORK)
    assert check_slot(BUSINESS, WEEK_HOURS, FLAT_REPAIR, same_instant, [], NOW) == 1
