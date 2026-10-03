"""The budget ledger against the real database (prepared, not yet run).

Run only with `python -m uv run pytest -m integration`, after the `provider_budget` migration has
been applied to the project by the owner. They use a far-future UTC day chosen at random, so they
never touch a real day's numbers; the API role cannot delete, so the aggregate rows of those days
stay (numbers only, no visitor data).
"""

import random
import threading
from collections.abc import Iterator
from datetime import date, timedelta

import pytest

from voice_agent_api.budget.ledger import BudgetCategory
from voice_agent_api.infrastructure.postgres import PostgresBudgetLedger, PostgresDatabase


@pytest.fixture
def ledger(db: PostgresDatabase) -> PostgresBudgetLedger:
    return PostgresBudgetLedger(db)


@pytest.fixture
def day() -> Iterator[date]:
    yield date(2090, 1, 1) + timedelta(days=random.randint(0, 3000))


def used(db: PostgresDatabase, day: date, category: BudgetCategory) -> int:
    with db.transaction() as cur:
        cur.execute(
            "select consumed from booking.provider_budget where day_utc = %s and category = %s",
            (day, category.value),
        )
        row = cur.fetchone()
    return int(row[0]) if row else 0


def test_reserve_settle_and_refund_round_trip(
    ledger: PostgresBudgetLedger, db: PostgresDatabase, day: date
) -> None:
    category = BudgetCategory.AGENT_TOKENS
    assert ledger.reserve(day, category, 400, 1000) is True
    assert used(db, day, category) == 400
    ledger.adjust(day, category, -250)
    assert used(db, day, category) == 150
    ledger.adjust(day, category, -5000)  # never below zero
    assert used(db, day, category) == 0


def test_a_reservation_never_passes_the_limit(
    ledger: PostgresBudgetLedger, db: PostgresDatabase, day: date
) -> None:
    category = BudgetCategory.SPEECH_SECONDS
    assert ledger.reserve(day, category, 60, 100) is True
    assert ledger.reserve(day, category, 60, 100) is False
    assert used(db, day, category) == 60


def test_concurrent_reservations_cannot_overspend(
    ledger: PostgresBudgetLedger, db: PostgresDatabase, day: date
) -> None:
    category = BudgetCategory.AGENT_TOKENS
    results: list[bool] = []
    lock = threading.Lock()

    def worker() -> None:
        granted = ledger.reserve(day, category, 100, 1000)
        with lock:
            results.append(granted)

    threads = [threading.Thread(target=worker) for _ in range(30)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sum(results) == 10
    assert used(db, day, category) == 1000


def test_the_role_can_neither_delete_nor_change_the_day_or_the_category(
    db: PostgresDatabase, day: date
) -> None:
    from psycopg import errors as pg_errors

    with db.transaction() as cur:
        cur.execute(
            "insert into booking.provider_budget (day_utc, category, consumed, limit_amount) "
            "values (%s, 'agent_tokens', 0, 1) on conflict do nothing",
            (day,),
        )
    with pytest.raises(pg_errors.InsufficientPrivilege), db.transaction() as cur:
        cur.execute("delete from booking.provider_budget where day_utc = %s", (day,))
    with pytest.raises(pg_errors.InsufficientPrivilege), db.transaction() as cur:
        cur.execute(
            "update booking.provider_budget set category = 'speech_seconds' where day_utc = %s",
            (day,),
        )
