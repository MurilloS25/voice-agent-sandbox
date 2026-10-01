from datetime import date

import pytest

from tests.support import NEW_YORK, NOW
from voice_agent_api.domain.errors import ServiceNotFound
from voice_agent_api.domain.queries import get_availability
from voice_agent_api.infrastructure.seed import build_seed


def test_unknown_service_raises() -> None:
    _catalog, appointments = build_seed(NOW)
    with pytest.raises(ServiceNotFound):
        get_availability(appointments, "nope", date(2026, 10, 1), NOW)


def test_seed_bookings_create_gaps_on_the_next_open_day() -> None:
    _catalog, appointments = build_seed(NOW)
    slots = get_availability(appointments, "flat-repair", date(2026, 10, 1), NOW)
    starts = {s.start.astimezone(NEW_YORK).strftime("%H:%M") for s in slots}
    assert "10:00" not in starts  # both benches busy with tune-ups
    assert "11:30" in starts
    assert "14:00" in starts  # only one bench busy 14:00-14:45


def test_seed_bookings_are_generated_relative_to_the_clock() -> None:
    _, appointments = build_seed(NOW)
    bookings = appointments.bookings_overlapping(NOW, NOW.replace(year=2027))
    assert len(bookings) == 4
    assert all(b.start > NOW for b in bookings)
