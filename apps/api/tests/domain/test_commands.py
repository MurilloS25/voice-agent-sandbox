import re
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime, time, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo

import pytest

from tests.support import (
    FLAT_REPAIR,
    NOW,
    SLOT_START,
    WEEK_HOURS,
    MutableCatalog,
    id_sequence,
    local_booking,
    make_world,
)
from voice_agent_api.domain.aliases import alias_for
from voice_agent_api.domain.commands import (
    PROPOSAL_TTL,
    confirm_appointment,
    propose_appointment,
)
from voice_agent_api.domain.errors import (
    ProposalExpired,
    ProposalStale,
    ServiceNotFound,
    SlotNotOffered,
    SlotUnavailable,
)
from voice_agent_api.domain.fingerprint import catalog_fingerprint
from voice_agent_api.domain.models import Booking, Money, OpeningInterval, Proposal, WeeklyHours
from voice_agent_api.infrastructure.in_memory import InMemoryAppointmentBook

ALIAS_FORMAT = re.compile(r"Demo [A-Z][a-z]+ [A-Z][a-z]+")
DAY = (datetime(2026, 10, 6, 0, tzinfo=UTC), datetime(2026, 10, 8, 0, tzinfo=UTC))


def fixed_id(n: int) -> Callable[[], UUID]:
    return lambda: UUID(int=n)


def propose(catalog: MutableCatalog, book: InMemoryAppointmentBook, n: int = 1) -> Proposal:
    review = propose_appointment(book, "flat-repair", SLOT_START, NOW, fixed_id(n))
    return review.proposal


def stored(book: InMemoryAppointmentBook) -> int:
    return len(book.bookings_overlapping(*DAY))


def test_propose_describes_the_booking_and_writes_nothing() -> None:
    catalog, book = make_world()
    review = propose_appointment(book, "flat-repair", SLOT_START, NOW, id_sequence())

    assert review.service == FLAT_REPAIR
    assert review.timezone == "America/New_York"
    assert review.end == SLOT_START + timedelta(minutes=30)
    assert ALIAS_FORMAT.fullmatch(review.customer_alias)
    assert review.customer_alias == alias_for(review.proposal.id)
    assert review.proposal.start == SLOT_START
    assert review.proposal.expires_at == NOW + PROPOSAL_TTL
    assert review.proposal.fingerprint == catalog_fingerprint(catalog.business(), FLAT_REPAIR)
    assert stored(book) == 0


def test_propose_expiry_is_whole_seconds() -> None:
    _catalog, book = make_world()
    now = NOW.replace(microsecond=987654)
    review = propose_appointment(book, "flat-repair", SLOT_START, now, id_sequence())
    assert review.proposal.expires_at.microsecond == 0


def test_propose_rejects_an_unknown_service() -> None:
    _catalog, book = make_world()
    with pytest.raises(ServiceNotFound):
        propose_appointment(book, "nope", SLOT_START, NOW, id_sequence())


def test_propose_rejects_a_start_that_is_not_offered() -> None:
    _catalog, book = make_world()
    with pytest.raises(SlotNotOffered):
        propose_appointment(
            book, "flat-repair", SLOT_START + timedelta(minutes=15), NOW, id_sequence()
        )


def test_propose_rejects_a_slot_with_no_free_bench() -> None:
    both = [
        Booking("x", SLOT_START, SLOT_START + timedelta(minutes=30), 1),
        Booking("y", SLOT_START, SLOT_START + timedelta(minutes=30), 2),
    ]
    _catalog, book = make_world(both)
    with pytest.raises(SlotUnavailable):
        propose_appointment(book, "flat-repair", SLOT_START, NOW, id_sequence())


def test_confirm_stores_values_recomputed_from_the_catalog() -> None:
    catalog, book = make_world()
    proposal = propose(catalog, book)

    appointment, created = confirm_appointment(book, proposal, NOW)

    assert created
    assert appointment.business_id == catalog.business().id
    assert appointment.service_id == "flat-repair"
    assert appointment.start == SLOT_START
    assert appointment.end == SLOT_START + FLAT_REPAIR.duration
    assert appointment.bench == 1
    assert appointment.status == "confirmed"
    assert appointment.customer_alias == alias_for(proposal.id)
    assert appointment.source == "web_demo"
    assert appointment.proposal_id == proposal.id
    assert appointment.created_at == NOW
    assert book.get(appointment.id) == appointment
    assert stored(book) == 1


def test_confirm_assigns_the_lowest_free_bench() -> None:
    taken = [local_booking("x", SLOT_START.date(), time(10, 0), 30, bench=1)]
    catalog, book = make_world(taken)
    appointment, _ = confirm_appointment(book, propose(catalog, book), NOW)
    assert appointment.bench == 2


def test_replay_returns_the_original_and_writes_nothing_more() -> None:
    catalog, book = make_world()
    proposal = propose(catalog, book)
    first, created_first = confirm_appointment(book, proposal, NOW)
    second, created_second = confirm_appointment(book, proposal, NOW)

    assert (created_first, created_second) == (True, False)
    assert second == first
    assert stored(book) == 1


def test_replay_still_succeeds_after_expiry() -> None:
    catalog, book = make_world()
    proposal = propose(catalog, book)
    first, _ = confirm_appointment(book, proposal, NOW)
    replay, created = confirm_appointment(book, proposal, NOW + timedelta(hours=1))
    assert (replay, created) == (first, False)


def test_expired_proposal_writes_nothing() -> None:
    catalog, book = make_world()
    proposal = propose(catalog, book)
    with pytest.raises(ProposalExpired):
        confirm_appointment(book, proposal, proposal.expires_at)
    assert stored(book) == 0


def test_a_slot_taken_in_the_meantime_is_a_conflict() -> None:
    catalog, book = make_world()
    first, second, third = (propose(catalog, book, n) for n in (1, 2, 3))
    assert confirm_appointment(book, first, NOW)[0].bench == 1
    assert confirm_appointment(book, second, NOW)[0].bench == 2
    with pytest.raises(SlotUnavailable):
        confirm_appointment(book, third, NOW)
    assert stored(book) == 2


def _change_price(catalog: MutableCatalog) -> None:
    catalog.set_service(replace(FLAT_REPAIR, price=Money(1600, "USD")))


def _change_duration(catalog: MutableCatalog) -> None:
    catalog.set_service(replace(FLAT_REPAIR, duration=timedelta(minutes=60)))


def _change_name(catalog: MutableCatalog) -> None:
    catalog.set_service(replace(FLAT_REPAIR, name="Flat fix"))


def _change_timezone(catalog: MutableCatalog) -> None:
    catalog.set_business(replace(catalog.business(), timezone=ZoneInfo("America/Chicago")))


def _change_business_id(catalog: MutableCatalog) -> None:
    catalog.set_business(replace(catalog.business(), id="renamed"))


def _change_currency(catalog: MutableCatalog) -> None:
    catalog.set_business(replace(catalog.business(), currency="EUR"))


def _remove_service(catalog: MutableCatalog) -> None:
    catalog.remove_service("flat-repair")


@pytest.mark.parametrize(
    "change",
    [
        _change_price,
        _change_duration,
        _change_name,
        _change_timezone,
        _change_business_id,
        _change_currency,
        _remove_service,
    ],
)
def test_a_changed_catalog_makes_the_proposal_stale_and_writes_nothing(
    change: Callable[[MutableCatalog], None],
) -> None:
    catalog, book = make_world()
    proposal = propose(catalog, book)
    change(catalog)

    with pytest.raises(ProposalStale):
        confirm_appointment(book, proposal, NOW)

    assert stored(book) == 0


def test_a_changed_description_does_not_make_the_proposal_stale() -> None:
    catalog, book = make_world()
    proposal = propose(catalog, book)
    catalog.set_service(replace(FLAT_REPAIR, description="New wording only."))
    assert confirm_appointment(book, proposal, NOW)[1]


def test_changed_hours_that_keep_the_slot_do_not_make_the_proposal_stale() -> None:
    catalog, book = make_world()
    proposal = propose(catalog, book)
    # Same Tuesday opening, plus an extra evening interval.
    catalog.set_hours(
        WeeklyHours((*WEEK_HOURS.intervals, OpeningInterval(1, time(19, 0), time(20, 0))))
    )
    assert confirm_appointment(book, proposal, NOW)[1]


def test_hours_that_remove_the_slot_are_not_offered_rather_than_stale() -> None:
    catalog, book = make_world()
    proposal = propose(catalog, book)
    catalog.set_hours(WeeklyHours(()))
    with pytest.raises(SlotNotOffered):
        confirm_appointment(book, proposal, NOW)
    assert stored(book) == 0


def test_replay_after_a_catalog_change_returns_the_original() -> None:
    catalog, book = make_world()
    proposal = propose(catalog, book)
    first, _ = confirm_appointment(book, proposal, NOW)
    _change_price(catalog)
    again, created = confirm_appointment(book, proposal, NOW)
    assert (again, created) == (first, False)


def test_expiry_is_reported_before_staleness() -> None:
    catalog, book = make_world()
    proposal = propose(catalog, book)
    _change_price(catalog)
    with pytest.raises(ProposalExpired):
        confirm_appointment(book, proposal, proposal.expires_at + timedelta(seconds=1))


def test_staleness_is_reported_before_slot_checks() -> None:
    both = [
        Booking("x", SLOT_START, SLOT_START + timedelta(minutes=30), 1),
        Booking("y", SLOT_START, SLOT_START + timedelta(minutes=30), 2),
    ]
    catalog, book = make_world()
    proposal = propose(catalog, book)
    _change_price(catalog)
    full_book = InMemoryAppointmentBook(catalog, both, lambda: NOW)
    with pytest.raises(ProposalStale):
        confirm_appointment(full_book, proposal, NOW)


def test_a_forged_proposal_with_a_matching_fingerprint_still_books_catalog_values() -> None:
    # Only id, service, start, expiry and the fingerprint are used. Everything stored is
    # recomputed, so a proposal cannot smuggle in an end time, alias or bench.
    catalog, book = make_world()
    forged = Proposal(
        id=UUID(int=7),
        service_id="flat-repair",
        start=SLOT_START,
        expires_at=NOW + timedelta(minutes=5),
        fingerprint=catalog_fingerprint(catalog.business(), FLAT_REPAIR),
    )
    appointment, _ = confirm_appointment(book, forged, NOW)
    assert appointment.end == SLOT_START + FLAT_REPAIR.duration
    assert appointment.customer_alias == alias_for(forged.id)
    assert appointment.bench == 1


def test_a_wrong_fingerprint_is_stale_even_if_everything_else_is_valid() -> None:
    _catalog, book = make_world()
    forged = Proposal(
        id=UUID(int=7),
        service_id="flat-repair",
        start=SLOT_START,
        expires_at=NOW + timedelta(minutes=5),
        fingerprint="A" * 22,
    )
    with pytest.raises(ProposalStale):
        confirm_appointment(book, forged, NOW)
    assert stored(book) == 0
