import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from uuid import UUID

from tests.support import NOW, SLOT_START, make_world
from voice_agent_api.domain.commands import confirm_appointment, propose_appointment
from voice_agent_api.domain.errors import SlotUnavailable
from voice_agent_api.domain.models import Appointment
from voice_agent_api.infrastructure.seed import BUSINESS, seed_bookings

THREADS = 8
DAY = (datetime(2026, 10, 6, tzinfo=UTC), datetime(2026, 10, 8, tzinfo=UTC))


def fixed_id(n: int) -> Callable[[], UUID]:
    return lambda: UUID(int=n)


def race[T](work: Callable[[int], T]) -> list[T | Exception]:
    """Run `work(i)` on THREADS threads released together; collect results or exceptions."""
    barrier = threading.Barrier(THREADS)

    def run(i: int) -> T | Exception:
        barrier.wait()
        try:
            return work(i)
        except Exception as exc:
            return exc

    with ThreadPoolExecutor(THREADS) as pool:
        return list(pool.map(run, range(THREADS)))


def test_racing_proposals_for_the_last_benches_create_exactly_two_appointments() -> None:
    _catalog, book = make_world()
    proposals = [
        propose_appointment(book, "flat-repair", SLOT_START, NOW, fixed_id(i + 1)).proposal
        for i in range(THREADS)
    ]

    results = race(lambda i: confirm_appointment(book, proposals[i], NOW))

    created = [r[0] for r in results if isinstance(r, tuple) and r[1]]
    conflicts = [r for r in results if isinstance(r, SlotUnavailable)]
    assert len(created) == 2
    assert len(conflicts) == THREADS - 2
    assert {a.bench for a in created} == {1, 2}
    assert len(book.bookings_overlapping(*DAY)) == 2


def test_racing_the_same_proposal_creates_one_appointment_and_replays_the_rest() -> None:
    _catalog, book = make_world()
    proposal = propose_appointment(
        book, "flat-repair", SLOT_START, NOW, lambda: UUID(int=1)
    ).proposal

    results = race(lambda _: confirm_appointment(book, proposal, NOW))

    pairs: list[tuple[Appointment, bool]] = [r for r in results if isinstance(r, tuple)]
    assert len(pairs) == THREADS
    assert sum(1 for _, created in pairs if created) == 1
    assert len({a.id for a, _ in pairs}) == 1
    assert len(book.bookings_overlapping(*DAY)) == 1


def test_seed_bookings_assign_benches_that_never_overlap() -> None:
    bookings = seed_bookings(NOW)
    assert {b.bench for b in bookings} <= set(range(1, BUSINESS.bench_capacity + 1))
    for i, first in enumerate(bookings):
        for second in bookings[i + 1 :]:
            if first.bench == second.bench:
                assert first.end <= second.start or second.end <= first.start


def test_get_returns_none_for_an_unknown_id() -> None:
    _, book = make_world()
    assert book.get(UUID(int=99)) is None
