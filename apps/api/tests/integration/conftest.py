"""Integration tests: a real PostgreSQL database (Supabase), reached as `voice_agent_api`.

They write and delete rows with `source = 'test'`, so they only run when asked for
(`python -m uv run pytest -m integration`) and only if `apps/api/.env` holds valid Postgres
settings. Credentials are read from that git-ignored file and never printed.
"""

from collections.abc import Iterator
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path

import pytest

from voice_agent_api.config import ConfigError, Settings, load_settings, validate_settings
from voice_agent_api.infrastructure.postgres import PostgresDatabase

API_ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent

# A fixed clock far from the demo window, so test rows never collide with real demo bookings.
TEST_NOW = datetime(2030, 3, 5, 12, 0, tzinfo=UTC)


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    for item in items:
        if HERE in Path(str(item.fspath)).parents:
            item.add_marker(pytest.mark.integration)


def slot_start_on_open_day(extra_days: int = 2) -> datetime:
    """10:00 America/New_York on the first open weekday at least `extra_days` after TEST_NOW."""
    from zoneinfo import ZoneInfo

    day: date = TEST_NOW.date() + timedelta(days=extra_days)
    while day.weekday() not in (1, 2, 3, 4, 5):  # Tuesday to Saturday are open days
        day += timedelta(days=1)
    local = datetime.combine(day, time(10, 0), tzinfo=ZoneInfo("America/New_York"))
    return local.astimezone(UTC)


@pytest.fixture(scope="session")
def pg_settings() -> Settings:
    env_file = API_ROOT / ".env"
    if not env_file.exists():
        pytest.skip("apps/api/.env not found")
    try:
        settings = load_settings(env_file=str(env_file))
        postgres = settings.model_copy(update={"appointment_store": "postgres"})
        return validate_settings(postgres)
    except ConfigError:
        pytest.skip("apps/api/.env does not hold valid postgres settings")


@pytest.fixture(scope="session")
def db(pg_settings: Settings) -> Iterator[PostgresDatabase]:
    database = PostgresDatabase(pg_settings)
    database.open()
    yield database
    database.close()


def delete_test_rows(db: PostgresDatabase) -> None:
    with db.transaction() as cur:
        cur.execute("delete from booking.appointments where source = 'test'")


def count_test_rows(db: PostgresDatabase) -> int:
    with db.transaction() as cur:
        cur.execute("select pg_catalog.count(*) from booking.appointments where source = 'test'")
        row = cur.fetchone()
    assert row is not None
    return int(row[0])


@pytest.fixture(autouse=True)
def clean_rows(db: PostgresDatabase) -> Iterator[None]:
    delete_test_rows(db)
    yield
    delete_test_rows(db)
