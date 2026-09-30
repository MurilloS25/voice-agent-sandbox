from datetime import UTC, date, datetime, time, timedelta

import pytest

from tests.support import (
    FLAT_REPAIR,
    NEW_YORK,
    NOW,
    OVERHAUL,
    SUNDAY_NIGHT_HOURS,
    TUNE_UP,
    WEEK_HOURS,
    local_booking,
    make_business,
)
from voice_agent_api.domain.availability import available_slots, booking_window
from voice_agent_api.domain.errors import DateOutsideBookingWindow
from voice_agent_api.domain.models import Booking, Service, Slot

TUESDAY = date(2026, 10, 6)
MONDAY = date(2026, 10, 5)
SATURDAY = date(2026, 10, 10)


def local_starts(slots: list[Slot]) -> list[str]:
    return [s.start.astimezone(NEW_YORK).strftime("%H:%M") for s in slots]


def slots_for(
    service: Service,
    day: date,
    bookings: list[Booking] | None = None,
    now: datetime = NOW,
    **business_kwargs: int | timedelta,
) -> list[Slot]:
    return available_slots(
        make_business(**business_kwargs),  # type: ignore[arg-type]
        WEEK_HOURS,
        service,
        day,
        bookings or [],
        now,
    )


def test_booking_window_is_local_today_through_horizon() -> None:
    window = booking_window(make_business(), NOW)
    assert window.first_date == date(2026, 9, 30)
    assert window.last_date == date(2026, 10, 14)


def test_closed_day_has_no_slots() -> None:
    assert slots_for(FLAT_REPAIR, MONDAY) == []


def test_lunch_break_splits_the_day() -> None:
    starts = local_starts(slots_for(FLAT_REPAIR, TUESDAY))
    assert starts[:2] == ["09:00", "09:30"]
    assert "12:30" in starts
    assert "13:00" not in starts
    assert "13:30" not in starts
    assert "14:00" in starts
    assert starts[-1] == "17:30"
    assert len(starts) == 16


def test_service_must_fit_inside_one_interval() -> None:
    starts = local_starts(slots_for(TUNE_UP, TUESDAY))
    morning = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"]  # 12:00 would end at 13:30
    afternoon = ["14:00", "14:30", "15:00", "15:30", "16:00", "16:30"]  # 17:00 would end at 18:30
    assert starts == morning + afternoon


def test_slot_may_end_exactly_at_closing() -> None:
    slots = slots_for(TUNE_UP, TUESDAY)
    last_morning = next(s for s in slots if local_starts([s]) == ["11:30"])
    assert last_morning.end.astimezone(NEW_YORK).time() == time(13, 0)


def test_service_longer_than_half_a_day_gets_one_slot_per_interval() -> None:
    assert local_starts(slots_for(OVERHAUL, TUESDAY)) == ["09:00", "14:00"]


def test_lead_time_hides_slots_that_start_too_soon() -> None:
    # 09:00 EDT on Tuesday; two hours of lead time means 11:00 is the first bookable start.
    now = datetime(2026, 10, 6, 13, 0, tzinfo=UTC)
    starts = local_starts(slots_for(FLAT_REPAIR, TUESDAY, now=now))
    assert starts[0] == "11:00"


@pytest.mark.parametrize("day", [date(2026, 9, 29), date(2026, 10, 15)])
def test_dates_outside_the_window_are_rejected(day: date) -> None:
    with pytest.raises(DateOutsideBookingWindow):
        slots_for(FLAT_REPAIR, day)


def test_window_edges_are_inclusive() -> None:
    assert slots_for(FLAT_REPAIR, date(2026, 10, 14)) != []  # last day, a Wednesday
    assert slots_for(FLAT_REPAIR, date(2026, 9, 30), horizon_days=14) != []


def test_one_booking_leaves_the_other_bench_free() -> None:
    bookings = [local_booking("x", TUESDAY, time(10, 0), 30)]
    assert "10:00" in local_starts(slots_for(FLAT_REPAIR, TUESDAY, bookings))


def test_full_benches_block_only_overlapping_slots() -> None:
    bookings = [
        local_booking("x", TUESDAY, time(10, 0), 30),
        local_booking("y", TUESDAY, time(10, 0), 30),
    ]
    starts = local_starts(slots_for(FLAT_REPAIR, TUESDAY, bookings))
    assert "10:00" not in starts
    assert "09:30" in starts  # ends exactly when the bookings start
    assert "10:30" in starts  # starts exactly when the bookings end


def test_back_to_back_bookings_only_ever_occupy_one_bench() -> None:
    # Two benches; 10:00-10:45 and 10:45-11:30 never run at the same time, so a 45-minute
    # job at 10:30-11:15 still has a free bench the whole way through.
    brake = Service("brake", "Brake adjustment", "", timedelta(minutes=45), FLAT_REPAIR.price)
    bookings = [
        local_booking("x", TUESDAY, time(10, 0), 45),
        local_booking("y", TUESDAY, time(10, 45), 45),
    ]
    assert "10:30" in local_starts(slots_for(brake, TUESDAY, bookings))


def test_overlap_reaching_capacity_anywhere_inside_the_span_blocks_the_slot() -> None:
    # Both benches are busy 10:30-10:45 (x runs 10:30-11:30, y runs 10:30-10:45).
    brake = Service("brake", "Brake adjustment", "", timedelta(minutes=45), FLAT_REPAIR.price)
    bookings = [
        local_booking("x", TUESDAY, time(10, 30), 60),
        local_booking("y", TUESDAY, time(10, 30), 15),
    ]
    starts = local_starts(slots_for(brake, TUESDAY, bookings))
    assert "10:00" not in starts  # 10:00-10:45 is inside the fully busy stretch
    assert "10:30" not in starts  # starts while both benches are busy
    assert "09:30" in starts  # 09:30-10:15 ends before either booking starts
    assert "11:00" in starts  # y has finished, so one bench is free from 10:45


def test_long_service_is_blocked_by_a_booking_inside_its_span() -> None:
    bookings = [
        local_booking("x", TUESDAY, time(10, 30), 30),
        local_booking("y", TUESDAY, time(10, 30), 30),
    ]
    starts = local_starts(slots_for(TUNE_UP, TUESDAY, bookings))
    # Every 90-minute start from 09:30 through 10:30 overlaps the busy half hour.
    assert starts[:2] == ["09:00", "11:00"]
    assert "09:30" not in starts
    assert "10:30" not in starts


def test_saturday_nine_am_maps_to_utc_across_dst() -> None:
    edt = slots_for(FLAT_REPAIR, SATURDAY)[0]
    assert edt.start == datetime(2026, 10, 10, 13, 0, tzinfo=UTC)  # UTC-4

    est_now = datetime(2026, 11, 2, 12, 0, tzinfo=UTC)
    est = slots_for(FLAT_REPAIR, date(2026, 11, 7), now=est_now)[0]
    assert est.start == datetime(2026, 11, 7, 14, 0, tzinfo=UTC)  # UTC-5


def test_spring_forward_skips_the_nonexistent_hour() -> None:
    now = datetime(2026, 3, 5, 12, 0, tzinfo=UTC)
    slots = available_slots(
        make_business(), SUNDAY_NIGHT_HOURS, FLAT_REPAIR, date(2026, 3, 8), [], now
    )
    assert [s.start.strftime("%H:%M") for s in slots] == ["06:00", "06:30", "07:00", "07:30"]
    assert local_starts(slots) == ["01:00", "01:30", "03:00", "03:30"]


def test_fall_back_never_duplicates_the_repeated_hour() -> None:
    now = datetime(2026, 10, 28, 12, 0, tzinfo=UTC)
    slots = available_slots(
        make_business(), SUNDAY_NIGHT_HOURS, FLAT_REPAIR, date(2026, 11, 1), [], now
    )
    starts = [s.start.strftime("%H:%M") for s in slots]
    assert starts == ["05:00", "05:30", "07:00", "07:30", "08:00", "08:30"]
    assert len(set(starts)) == len(starts)


def test_slots_are_sorted_utc_datetimes() -> None:
    slots = slots_for(FLAT_REPAIR, TUESDAY)
    assert slots == sorted(slots, key=lambda s: s.start)
    assert all(s.start.utcoffset() == timedelta(0) for s in slots)
    assert all(s.end - s.start == FLAT_REPAIR.duration for s in slots)
