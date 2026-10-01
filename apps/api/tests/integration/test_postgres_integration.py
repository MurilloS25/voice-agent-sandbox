"""Behavior that only a real database can prove: constraints, locks, timeouts, concurrency."""

import asyncio
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from typing import Any
from uuid import uuid4

import httpx
import pytest
from psycopg import errors as pg_errors

from tests.integration.conftest import (
    TEST_NOW,
    count_test_rows,
    slot_start_on_open_day,
)
from voice_agent_api.api.proposal_tokens import ProposalTokenCodec
from voice_agent_api.config import Settings
from voice_agent_api.domain.commands import confirm_appointment, propose_appointment
from voice_agent_api.domain.errors import ProposalStale, SlotUnavailable, StorageUnavailable
from voice_agent_api.domain.models import Proposal
from voice_agent_api.factory import create_app
from voice_agent_api.infrastructure import postgres
from voice_agent_api.infrastructure.postgres import (
    PostgresAppointmentBook,
    PostgresCatalog,
    PostgresDatabase,
    day_lock_key,
)
from voice_agent_api.infrastructure.seed import BUSINESS, HOURS, SERVICES

THREADS = 8
SOURCE = "test"


def stores(
    db: PostgresDatabase, settings: Settings
) -> tuple[PostgresCatalog, PostgresAppointmentBook]:
    return PostgresCatalog(db, settings.business_id), PostgresAppointmentBook(
        db, settings.business_id
    )


def new_proposal(
    catalog: PostgresCatalog, book: PostgresAppointmentBook, start: datetime
) -> Proposal:
    return propose_appointment(book, "flat-repair", start, TEST_NOW, uuid4).proposal


def race(work: Any) -> list[Any]:
    barrier = threading.Barrier(THREADS)

    def run(i: int) -> Any:
        barrier.wait()
        try:
            return work(i)
        except Exception as exc:
            return exc

    with ThreadPoolExecutor(THREADS) as pool:
        return list(pool.map(run, range(THREADS)))


# --- schema and session hardening ----------------------------------------------------------


def test_schema_is_private_with_rls_everywhere_and_a_least_privilege_role(
    db: PostgresDatabase,
) -> None:
    with db.transaction() as cur:
        cur.execute(
            "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace "
            "where n.nspname = 'booking' and c.relkind = 'r' and not c.relrowsecurity"
        )
        assert cur.fetchall() == []  # every table has RLS enabled

        cur.execute(
            "select has_schema_privilege('anon', 'booking', 'usage'), "
            "has_schema_privilege('authenticated', 'booking', 'usage'), "
            "has_schema_privilege('service_role', 'booking', 'usage'), "
            "has_table_privilege('voice_agent_api', 'booking.appointments', 'select'), "
            "has_table_privilege('voice_agent_api', 'booking.appointments', 'update'), "
            "has_table_privilege('voice_agent_api', 'booking.services', 'insert')"
        )
        assert cur.fetchone() == (False, False, False, True, False, False)

        cur.execute(
            "select rolcanlogin, rolbypassrls, rolsuper from pg_roles "
            "where rolname = 'voice_agent_api'"
        )
        assert cur.fetchone() == (True, False, False)

        cur.execute(
            "select conname from pg_constraint "
            "where conname = 'appointments_no_bench_overlap' and contype = 'x'"
        )
        assert cur.fetchone() is not None
        cur.execute("select extname from pg_extension where extname = 'btree_gist'")
        assert cur.fetchone() is not None


def test_every_transaction_pins_search_path_and_timeouts(db: PostgresDatabase) -> None:
    with db.transaction() as cur:
        cur.execute(
            "select pg_catalog.current_setting('search_path'), "
            "pg_catalog.current_setting('statement_timeout'), "
            "pg_catalog.current_setting('lock_timeout'), "
            "pg_catalog.current_setting('idle_in_transaction_session_timeout')"
        )
        assert cur.fetchone() == ("pg_catalog, pg_temp", "1s", "1s", "5s")


def test_an_unqualified_table_name_does_not_resolve(db: PostgresDatabase) -> None:
    with db._pool.connection() as conn:
        conn.execute(postgres._SQL_PREAMBLE, ("1000", "1000", "5000"))
        with pytest.raises(pg_errors.UndefinedTable):
            conn.execute("select 1 from appointments")


def test_the_catalog_matches_the_in_memory_seed(
    db: PostgresDatabase, pg_settings: Settings
) -> None:
    catalog, _ = stores(db, pg_settings)
    snapshot = catalog.snapshot("flat-repair")
    assert snapshot.business == BUSINESS
    assert snapshot.hours == HOURS
    assert tuple(catalog.services()) == SERVICES
    assert snapshot.service == SERVICES[0]


# --- booking, idempotency and concurrency --------------------------------------------------


def test_confirm_persists_replays_and_reads_back(
    db: PostgresDatabase, pg_settings: Settings
) -> None:
    catalog, book = stores(db, pg_settings)
    start = slot_start_on_open_day()
    proposal = new_proposal(catalog, book, start)

    appointment, created = confirm_appointment(book, proposal, TEST_NOW, source=SOURCE)
    replay, replayed_created = confirm_appointment(book, proposal, TEST_NOW, source=SOURCE)

    assert created and not replayed_created
    assert replay == appointment
    assert appointment.bench == 1
    assert appointment.end - appointment.start == timedelta(minutes=30)
    assert appointment.start == start
    assert appointment.status == "confirmed" and appointment.source == SOURCE
    assert appointment.customer_alias.startswith("Demo ")
    assert book.get(appointment.id) == appointment
    assert count_test_rows(db) == 1


def test_racing_proposals_for_one_slot_create_exactly_one_per_bench(
    db: PostgresDatabase, pg_settings: Settings
) -> None:
    catalog, book = stores(db, pg_settings)
    start = slot_start_on_open_day()
    proposals = [new_proposal(catalog, book, start) for _ in range(THREADS)]

    results = race(lambda i: confirm_appointment(book, proposals[i], TEST_NOW, source=SOURCE))

    # Classify every result. A cold, bounded connection pool means a racing request may
    # legitimately fail to acquire a connection in time and surface as StorageUnavailable. That
    # is a safe, retryable 503 that writes nothing. The test still requires the two available
    # benches to be filled exactly once each and prohibits every unexpected result.
    created: list[int] = []  # bench numbers of newly created appointments
    replayed = 0
    conflicts = 0
    unavailable = 0
    unexpected: list[str] = []  # exception class names only, never messages or reprs
    for result in results:
        if isinstance(result, tuple) and len(result) == 2:
            appointment, was_created = result
            if was_created:
                created.append(appointment.bench)
            else:
                replayed += 1
        elif isinstance(result, SlotUnavailable):
            conflicts += 1
        elif isinstance(result, StorageUnavailable):
            unavailable += 1
        else:
            unexpected.append(type(result).__name__)

    # Plain integers and class names only, so a failing assertion cannot print an appointment,
    # an identifier, an alias or an exception message.
    created_count = len(created)
    persisted = count_test_rows(db)
    outcomes = (
        f"created={created_count} replayed={replayed} slot_unavailable={conflicts} "
        f"storage_unavailable={unavailable} unexpected={sorted(unexpected)}"
    )
    assert unexpected == [], outcomes  # includes any DatabaseFault or other exception type
    assert replayed == 0, outcomes  # every proposal is distinct, so nothing can be a replay
    assert created_count == 2, outcomes  # exactly the two benches, no more and no fewer
    assert sorted(created) == [1, 2], outcomes  # distinct benches, exactly {1, 2}
    assert conflicts + unavailable == THREADS - 2, outcomes  # every other result is controlled
    assert persisted == created_count == 2, outcomes  # what is stored equals what was created


def test_racing_the_same_proposal_creates_one_row_and_replays_the_rest(
    db: PostgresDatabase, pg_settings: Settings
) -> None:
    catalog, book = stores(db, pg_settings)
    proposal = new_proposal(catalog, book, slot_start_on_open_day())

    results = race(lambda _: confirm_appointment(book, proposal, TEST_NOW, source=SOURCE))

    # Reduce everything to integers and exception class names before asserting, so a failure can
    # never print an appointment, an identifier, an alias or an exception message.
    pairs = 0
    created = 0
    appointment_ids = set()
    unexpected: list[str] = []  # exception class names only, never messages or reprs
    for result in results:
        if isinstance(result, tuple) and len(result) == 2:
            appointment, was_created = result
            pairs += 1
            created += 1 if was_created else 0
            appointment_ids.add(appointment.id)
        else:
            unexpected.append(type(result).__name__)
    distinct_appointments = len(appointment_ids)
    rows = count_test_rows(db)
    summary = (
        f"pairs={pairs} created={created} distinct_appointments={distinct_appointments} "
        f"rows={rows} unexpected={sorted(unexpected)}"
    )
    assert pairs == THREADS, summary  # every thread returned a (appointment, created) result
    assert unexpected == [], summary  # no exception of any kind
    assert created == 1, summary  # exactly one thread created the appointment
    assert distinct_appointments == 1, summary  # all eight results are the same appointment
    assert rows == 1, summary  # exactly one source='test' row is stored


def test_the_exclusion_constraint_rejects_a_raw_overlapping_insert(db: PostgresDatabase) -> None:
    start = slot_start_on_open_day()
    params = ("quillwheel", "flat-repair", 1, start, start + timedelta(minutes=30))

    def insert(cur: Any) -> None:
        cur.execute(
            "insert into booking.appointments (business_id, service_id, bench_no, starts_at, "
            "ends_at, status, customer_alias, source, service_name, price_amount_minor, "
            "price_currency, timezone) "
            "values (%s, %s, %s, %s, %s, 'confirmed', 'Demo Raw Insert', 'test', "
            "'Flat repair', 1500, 'USD', 'America/New_York')",
            params,
        )

    with db.transaction() as cur:
        insert(cur)
    with pytest.raises(pg_errors.ExclusionViolation) as raised, db.transaction() as cur:
        insert(cur)
    assert raised.value.diag.constraint_name == "appointments_no_bench_overlap"
    assert count_test_rows(db) == 1


def test_a_stale_fingerprint_writes_nothing(db: PostgresDatabase, pg_settings: Settings) -> None:
    catalog, book = stores(db, pg_settings)
    good = new_proposal(catalog, book, slot_start_on_open_day())
    stale = Proposal(good.id, good.service_id, good.start, good.expires_at, "A" * 22)

    with pytest.raises(ProposalStale):
        confirm_appointment(book, stale, TEST_NOW, source=SOURCE)
    assert count_test_rows(db) == 0


# --- failure modes: timeouts, saturation, unreachable database -----------------------------


def short_timeouts(settings: Settings, **overrides: Any) -> Settings:
    return settings.model_copy(update=overrides)


def hold_day_lock(
    db: PostgresDatabase, key: int, held: threading.Event, release: threading.Event
) -> None:
    with db.transaction() as cur:
        cur.execute("select pg_catalog.pg_advisory_xact_lock(%s::bigint)", (key,))
        held.set()
        release.wait(10)


def test_a_held_day_lock_times_out_as_storage_unavailable_without_blocking_other_days(
    db: PostgresDatabase, pg_settings: Settings
) -> None:
    fast = PostgresDatabase(short_timeouts(pg_settings, db_lock_timeout_ms=300))
    fast.open()
    try:
        catalog, book = stores(fast, pg_settings)
        busy_start = slot_start_on_open_day()
        other_start = slot_start_on_open_day(extra_days=4)
        busy = new_proposal(catalog, book, busy_start)
        other = new_proposal(catalog, book, other_start)

        key = day_lock_key(pg_settings.business_id, busy_start.astimezone(BUSINESS.timezone).date())
        held, release = threading.Event(), threading.Event()
        holder = threading.Thread(target=hold_day_lock, args=(db, key, held, release))
        holder.start()
        assert held.wait(5)
        try:
            started = time.perf_counter()
            with pytest.raises(StorageUnavailable):
                confirm_appointment(book, busy, TEST_NOW, source=SOURCE)
            assert time.perf_counter() - started < 3.0

            started = time.perf_counter()  # a different day is not blocked by that lock
            confirm_appointment(book, other, TEST_NOW, source=SOURCE)
            assert time.perf_counter() - started < 1.0
        finally:
            release.set()
            holder.join()
        assert count_test_rows(db) == 1  # only the other day's booking exists
    finally:
        fast.close()


def test_a_slow_statement_is_cut_off_by_the_statement_timeout(pg_settings: Settings) -> None:
    fast = PostgresDatabase(short_timeouts(pg_settings, db_statement_timeout_ms=200))
    fast.open()
    try:
        started = time.perf_counter()
        with pytest.raises(StorageUnavailable), fast.transaction() as cur:
            cur.execute("select pg_catalog.pg_sleep(3)")
        assert time.perf_counter() - started < 2.0
    finally:
        fast.close()


def test_a_saturated_pool_fails_fast_with_storage_unavailable(pg_settings: Settings) -> None:
    tiny = PostgresDatabase(short_timeouts(pg_settings, db_pool_max=1, db_pool_timeout_s=0.3))
    tiny.open()
    try:
        catalog = PostgresCatalog(tiny, pg_settings.business_id)
        with tiny._pool.connection():  # hold the only connection
            started = time.perf_counter()
            with pytest.raises(StorageUnavailable):
                catalog.snapshot()
            assert time.perf_counter() - started < 2.0
        assert catalog.snapshot().business.id == pg_settings.business_id  # recovered
    finally:
        tiny.close()


def test_an_unreachable_database_fails_to_open_with_the_fixed_message(
    pg_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(postgres, "_OPEN_TIMEOUT_S", 1.5)
    broken = PostgresDatabase(short_timeouts(pg_settings, db_port=1, db_connect_timeout_s=1))
    with pytest.raises(StorageUnavailable) as raised:
        broken.open()
    assert str(raised.value) == "The schedule service is temporarily unavailable."
    assert (pg_settings.db_host or "") not in repr(raised.value)


def test_a_wrong_password_never_leaks_into_the_error(
    pg_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    from pydantic import SecretStr

    monkeypatch.setattr(postgres, "_OPEN_TIMEOUT_S", 3.0)
    wrong = secrets.token_urlsafe(24)
    bad = PostgresDatabase(short_timeouts(pg_settings, db_password=SecretStr(wrong)))
    with pytest.raises(StorageUnavailable) as raised:
        bad.open()
    assert wrong not in repr(raised.value) + str(raised.value)


def test_the_event_loop_stays_responsive_while_the_database_call_is_blocked(
    db: PostgresDatabase, pg_settings: Settings
) -> None:
    fast = PostgresDatabase(short_timeouts(pg_settings, db_lock_timeout_ms=500))
    fast.open()
    try:
        catalog, book = stores(fast, pg_settings)
        start = slot_start_on_open_day()
        proposal = new_proposal(catalog, book, start)
        key = day_lock_key(pg_settings.business_id, start.astimezone(BUSINESS.timezone).date())
        signing_key = secrets.token_bytes(32)
        app = create_app(
            catalog, book, lambda: TEST_NOW, signing_key=signing_key, id_factory=lambda: uuid4()
        )
        token = ProposalTokenCodec(signing_key).encode(proposal)

        held, release = threading.Event(), threading.Event()
        holder = threading.Thread(target=hold_day_lock, args=(db, key, held, release))
        holder.start()
        assert held.wait(5)

        async def run() -> tuple[int, float]:
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                post = asyncio.create_task(
                    client.post("/v1/appointments", json={"proposal_token": token, "confirm": True})
                )
                await asyncio.sleep(0.1)  # the confirm is now waiting on the held lock
                probe = time.perf_counter()
                health = await client.get("/health")
                latency = time.perf_counter() - probe
                assert health.status_code == 200
                response = await post
                return response.status_code, latency

        try:
            status, health_latency = asyncio.run(run())
        finally:
            release.set()
            holder.join()
        assert status == 503
        assert health_latency < 0.2
        assert count_test_rows(db) == 0
    finally:
        fast.close()
