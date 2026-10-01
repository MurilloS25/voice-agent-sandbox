"""Offline tests for the Postgres adapter: SQL rules, lock key and error handling.

A scripted fake pool stands in for psycopg, so nothing here connects to a database. The real
behavior (locks, constraints, timeouts) is covered by `tests/integration`.
"""

import ast
import logging
import random
import re
import secrets
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

import psycopg
import psycopg_pool
import pytest
from psycopg import errors as pg_errors
from psycopg import pq
from pydantic import SecretStr

from tests.support import FLAT_REPAIR, NOW, SLOT_START, make_business
from voice_agent_api.config import Settings, generate_signing_key
from voice_agent_api.domain.aliases import alias_for
from voice_agent_api.domain.commands import confirm_appointment
from voice_agent_api.domain.errors import (
    ProposalStale,
    SlotUnavailable,
    StorageUnavailable,
)
from voice_agent_api.domain.fingerprint import catalog_fingerprint
from voice_agent_api.domain.models import Proposal
from voice_agent_api.infrastructure import postgres
from voice_agent_api.infrastructure.postgres import (
    DatabaseFault,
    PostgresAppointmentBook,
    PostgresCatalog,
    PostgresDatabase,
    day_lock_key,
)

MODULE_PATH = Path(postgres.__file__)
FIXED_MESSAGE = "The schedule service is temporarily unavailable."
SECRET_TEXT = "secret-host.example.invalid role=voice_agent_api INSERT INTO booking.appointments"


# --- the advisory-lock key ---------------------------------------------------------------


def test_lock_key_known_answers_never_change() -> None:
    # Pinned so the key is identical across Python versions and platforms.
    assert day_lock_key("quillwheel", date(2026, 10, 6)) == -5479315950461608205
    assert day_lock_key("quillwheel", date(2026, 10, 7)) == 3294521094079781715


def test_lock_key_is_always_inside_the_signed_bigint_range() -> None:
    rng = random.Random(1234)
    for _ in range(10_000):
        business = "".join(rng.choice("abcdefghij-") for _ in range(rng.randint(1, 12)))
        day = date(2026, 1, 1) + timedelta(days=rng.randint(0, 5000))
        assert -(2**63) <= day_lock_key(business, day) <= 2**63 - 1


def test_lock_key_distinguishes_days_and_businesses_and_is_deterministic() -> None:
    day = date(2026, 10, 6)
    assert day_lock_key("a", day) == day_lock_key("a", day)
    assert day_lock_key("a", day) != day_lock_key("a", day + timedelta(days=1))
    assert day_lock_key("a", day) != day_lock_key("b", day)


# --- SQL rules ---------------------------------------------------------------------------


def _sql_constants() -> dict[str, str]:
    return {
        name: value
        for name, value in vars(postgres).items()
        if name.startswith("_SQL_") and isinstance(value, str)
    }


def test_every_execute_call_takes_a_named_sql_constant() -> None:
    tree = ast.parse(MODULE_PATH.read_text("utf-8"))
    executes = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "execute"
    ]
    assert len(executes) >= 8
    for call in executes:
        first = call.args[0]
        assert isinstance(first, ast.Name) and first.id.startswith("_SQL_"), ast.dump(first)


def test_sql_constants_are_literal_concatenations_never_interpolated() -> None:
    tree = ast.parse(MODULE_PATH.read_text("utf-8"))

    def only_literals(node: ast.AST) -> bool:
        if isinstance(node, ast.Constant):
            return isinstance(node.value, str)
        if isinstance(node, ast.Name):
            return node.id.startswith("_SQL_") or node.id == "_APPOINTMENT_COLUMNS"
        if isinstance(node, ast.BinOp):
            return (
                isinstance(node.op, ast.Add)
                and only_literals(node.left)
                and only_literals(node.right)
            )
        return False

    found = 0
    for node in tree.body:
        if (
            isinstance(node, ast.AnnAssign)
            and isinstance(node.target, ast.Name)
            and (node.target.id.startswith("_SQL_") or node.target.id == "_APPOINTMENT_COLUMNS")
        ):
            found += 1
            assert node.value is not None and only_literals(node.value), node.target.id
    assert found == len(_sql_constants()) + 1


def test_every_table_and_function_is_schema_qualified() -> None:
    allowed_bare_calls = {"any"}
    for name, sql in _sql_constants().items():
        lowered = sql.lower()
        for table in re.findall(r"\b(?:from|join|into|update)\s+([a-z_][\w.]*)", lowered):
            assert table.startswith("booking."), f"{name}: unqualified table {table}"
        for function in re.findall(r"(?<![\w.])([a-z_]\w*)\(", lowered):
            assert function in allowed_bare_calls, f"{name}: unqualified function {function}()"


def test_the_preamble_pins_search_path_and_the_three_timeouts() -> None:
    preamble = postgres._SQL_PREAMBLE
    assert "'search_path', 'pg_catalog, pg_temp', true" in preamble
    for setting in ("statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout"):
        assert f"'{setting}', %s, true" in preamble
    assert preamble.count("%s") == 3  # timeouts are bound parameters, never interpolated


def test_no_statement_is_built_with_formatting_in_the_module() -> None:
    source = MODULE_PATH.read_text("utf-8")
    assert ".format(" not in source
    assert not re.search(r"execute\(\s*f[\"']", source)
    assert not re.search(r"execute\([^)]*%\s*\(", source)


# --- a scripted fake pool ----------------------------------------------------------------


class Script:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.one: dict[str, list[Any]] = {}
        self.many: dict[str, list[list[Any]]] = {}
        self.raises: dict[str, Exception] = {}


class FakeCursor:
    def __init__(self, script: Script) -> None:
        self.script = script
        self.last = ""
        self.rowcount = 0

    def execute(self, query: str, params: Any = None) -> None:
        self.script.calls.append((query, params))
        self.last = query
        if query in self.script.raises:
            raise self.script.raises[query]

    def fetchone(self) -> Any:
        queue = self.script.one.get(self.last)
        return queue.pop(0) if queue else None

    def fetchall(self) -> list[Any]:
        queue = self.script.many.get(self.last)
        return queue.pop(0) if queue else []

    def __enter__(self) -> "FakeCursor":
        return self

    def __exit__(self, *exc: object) -> None:
        return None


class FakeConnection:
    def __init__(self, script: Script) -> None:
        self.script = script

    def cursor(self) -> FakeCursor:
        return FakeCursor(self.script)


class FakePool:
    """Mimics `pool.connection()`: commit on success, roll back on any exception."""

    def __init__(self, script: Script, fail_on_enter: Exception | None = None) -> None:
        self.script = script
        self.fail_on_enter = fail_on_enter
        self.committed = 0
        self.rolled_back = 0

    @contextmanager
    def connection(self) -> Iterator[FakeConnection]:
        if self.fail_on_enter is not None:
            raise self.fail_on_enter
        try:
            yield FakeConnection(self.script)
        except BaseException:
            self.rolled_back += 1
            raise
        else:
            self.committed += 1


def make_settings() -> Settings:
    return Settings(
        _env_file=None,
        appointment_store="postgres",
        proposal_signing_key=SecretStr(generate_signing_key()),
        db_host="db.example.invalid",
        db_user="voice_agent_api.exampleref",
        db_password=SecretStr(secrets.token_urlsafe(32)),
        db_sslrootcert="/certs/ca.pem",
    )


def make_db(
    script: Script, fail_on_enter: Exception | None = None
) -> tuple[PostgresDatabase, FakePool]:
    db = PostgresDatabase(make_settings())  # builds the pool object but never connects
    pool = FakePool(script, fail_on_enter)
    db._pool = pool  # type: ignore[assignment]
    return db, pool


def pg_error(cls: type[psycopg.Error], constraint: str | None = None) -> psycopg.Error:
    info: dict[int, bytes | None] | None = (
        {int(pq.DiagnosticField.CONSTRAINT_NAME): constraint.encode()} if constraint else None
    )
    return cls(SECRET_TEXT, info=info)


# --- transaction behavior and error mapping -----------------------------------------------

MAPPED_TO_UNAVAILABLE: list[Exception] = [
    psycopg.OperationalError(SECRET_TEXT),
    psycopg.InterfaceError(SECRET_TEXT),
    psycopg.Error(SECRET_TEXT),
    psycopg_pool.PoolTimeout(SECRET_TEXT),
    psycopg_pool.TooManyRequests(SECRET_TEXT),
    psycopg_pool.PoolClosed(SECRET_TEXT),
    pg_errors.QueryCanceled(SECRET_TEXT),  # statement_timeout
    pg_errors.LockNotAvailable(SECRET_TEXT),  # lock_timeout
    pg_errors.IdleInTransactionSessionTimeout(SECRET_TEXT),
    pg_errors.DeadlockDetected(SECRET_TEXT),
    pg_errors.SerializationFailure(SECRET_TEXT),
    pg_errors.AdminShutdown(SECRET_TEXT),
    pg_errors.CannotConnectNow(SECRET_TEXT),
    pg_errors.UndefinedTable(SECRET_TEXT),
]


@pytest.mark.parametrize("error", MAPPED_TO_UNAVAILABLE, ids=lambda e: type(e).__name__)
def test_connection_and_database_errors_become_the_fixed_storage_error(
    error: Exception, caplog: pytest.LogCaptureFixture
) -> None:
    for where in ("enter", "body"):
        script = Script()
        db, pool = make_db(script, error if where == "enter" else None)

        def attempt(db: PostgresDatabase = db) -> None:
            with db.transaction():
                raise error  # reached only when the connection itself was fine

        with caplog.at_level(logging.DEBUG), pytest.raises(StorageUnavailable) as raised:
            attempt()

        assert str(raised.value) == FIXED_MESSAGE
        assert raised.value.__cause__ is None and raised.value.__suppress_context__
        assert SECRET_TEXT not in repr(raised.value)
        assert SECRET_TEXT not in caplog.text
        if where == "body":
            assert pool.rolled_back == 1 and pool.committed == 0


def test_a_failing_statement_inside_the_transaction_is_mapped_and_rolled_back() -> None:
    script = Script()
    script.raises[postgres._SQL_PING] = pg_errors.QueryCanceled(SECRET_TEXT)
    db, pool = make_db(script)
    with pytest.raises(StorageUnavailable), db.transaction() as cur:
        cur.execute(postgres._SQL_PING)
    assert pool.rolled_back == 1


def test_each_transaction_starts_with_the_preamble_and_bound_timeouts() -> None:
    script = Script()
    db, pool = make_db(script)
    with db.transaction() as cur:
        cur.execute(postgres._SQL_PING)

    first_query, first_params = script.calls[0]
    assert first_query == postgres._SQL_PREAMBLE
    assert first_params == ("1000", "1000", "5000")
    assert script.calls[1][0] == postgres._SQL_PING
    assert (pool.committed, pool.rolled_back) == (1, 0)


def test_domain_errors_pass_through_untouched_and_roll_back() -> None:
    db, pool = make_db(Script())
    with pytest.raises(SlotUnavailable), db.transaction():
        raise SlotUnavailable
    assert pool.rolled_back == 1


def test_integrity_errors_propagate_unmapped_after_the_rollback() -> None:
    db, pool = make_db(Script())
    error = pg_error(pg_errors.ExclusionViolation, "appointments_no_bench_overlap")
    with pytest.raises(pg_errors.ExclusionViolation), db.transaction():
        raise error
    assert pool.rolled_back == 1


def test_a_bug_in_the_body_rolls_back_and_propagates() -> None:
    db, pool = make_db(Script())
    with pytest.raises(ZeroDivisionError), db.transaction():
        1 / 0  # noqa: B018
    assert pool.rolled_back == 1


# --- confirm: statement order, replay, conflict and constraint handling -------------------

START = SLOT_START
PROPOSAL = Proposal(
    id=UUID(int=42),
    service_id="flat-repair",
    start=START,
    expires_at=NOW + timedelta(minutes=10),
    fingerprint=catalog_fingerprint(make_business(), FLAT_REPAIR),
)
BUSINESS_ROW = (
    "test", "Test Shop", "", "", "", "America/New_York", "USD", 30, 120, 14, 2,
    "flat-repair", "Flat repair", "", 30, 1500, "USD", 2,
)  # fmt: skip
HOURS_ROWS = [
    (weekday, time(9), time(13)) if i == 0 else (weekday, time(14), time(18))
    for weekday in (1, 2, 3, 4)
    for i in (0, 1)
]
CREATED_ROW = (
    UUID(int=1), "test", "flat-repair", 1, START, START + timedelta(minutes=30), "confirmed",
    "Demo Brisk Panda", "web_demo", PROPOSAL.id, NOW, NOW,
    "Flat repair", 1500, "USD", "America/New_York",
)  # fmt: skip


def scripted_book(script: Script) -> tuple[PostgresAppointmentBook, FakePool]:
    script.one[postgres._SQL_BUSINESS_AND_SERVICE] = [BUSINESS_ROW]
    script.many[postgres._SQL_HOURS] = [HOURS_ROWS]
    db, pool = make_db(script)
    return PostgresAppointmentBook(db, "test"), pool


def executed(script: Script) -> list[str]:
    return [query for query, _ in script.calls]


def test_confirm_runs_the_documented_statements_in_order_and_inserts_recomputed_values() -> None:
    script = Script()
    script.one[postgres._SQL_INSERT_APPOINTMENT] = [CREATED_ROW]
    book, pool = scripted_book(script)

    appointment, created = confirm_appointment(book, PROPOSAL, NOW)

    assert created and appointment.id == UUID(int=1)
    assert executed(script) == [
        postgres._SQL_PREAMBLE,
        postgres._SQL_BUSINESS_AND_SERVICE,
        postgres._SQL_HOURS,
        postgres._SQL_LOCK_DAY,
        postgres._SQL_APPOINTMENT_BY_PROPOSAL,
        postgres._SQL_BOOKINGS_OVERLAPPING,
        postgres._SQL_INSERT_APPOINTMENT,
    ]
    params = {query: p for query, p in script.calls}
    assert params[postgres._SQL_LOCK_DAY] == (day_lock_key("test", date(2026, 10, 6)),)
    assert params[postgres._SQL_BUSINESS_AND_SERVICE] == ("flat-repair", "test")
    assert params[postgres._SQL_INSERT_APPOINTMENT][:5] == (
        "test",
        "flat-repair",
        1,
        START,
        START + timedelta(minutes=30),
    )
    assert params[postgres._SQL_INSERT_APPOINTMENT][5:] == (
        alias_for(PROPOSAL.id),
        "web_demo",
        PROPOSAL.id,
        "Flat repair",  # the snapshot of what was booked, from the fresh catalog
        1500,
        "USD",
        "America/New_York",
    )
    assert (pool.committed, pool.rolled_back) == (1, 0)


def test_a_replay_returns_the_original_without_deciding_or_inserting() -> None:
    script = Script()
    script.one[postgres._SQL_APPOINTMENT_BY_PROPOSAL] = [CREATED_ROW]
    book, pool = scripted_book(script)

    def decide(*_: object) -> Any:
        raise AssertionError("decide must not run for a replay")

    appointment, created = book.confirm(PROPOSAL, decide)

    assert not created and appointment.id == UUID(int=1)
    assert postgres._SQL_INSERT_APPOINTMENT not in executed(script)
    assert postgres._SQL_BOOKINGS_OVERLAPPING not in executed(script)
    assert pool.committed == 1


def test_a_stale_proposal_never_reaches_the_insert_and_rolls_back() -> None:
    script = Script()
    script.one[postgres._SQL_BUSINESS_AND_SERVICE] = [
        (*BUSINESS_ROW[:15], 1600, "USD", BUSINESS_ROW[17])
    ]
    script.many[postgres._SQL_HOURS] = [HOURS_ROWS]
    db, pool = make_db(script)
    book = PostgresAppointmentBook(db, "test")

    with pytest.raises(ProposalStale):
        confirm_appointment(book, PROPOSAL, NOW)

    assert postgres._SQL_INSERT_APPOINTMENT not in executed(script)
    assert (pool.committed, pool.rolled_back) == (0, 1)


def test_a_missing_service_is_stale_not_an_error() -> None:
    script = Script()
    script.one[postgres._SQL_BUSINESS_AND_SERVICE] = [
        (*BUSINESS_ROW[:11], *([None] * 6), BUSINESS_ROW[17])
    ]
    script.many[postgres._SQL_HOURS] = [HOURS_ROWS]
    db, _ = make_db(script)
    with pytest.raises(ProposalStale):
        confirm_appointment(PostgresAppointmentBook(db, "test"), PROPOSAL, NOW)


def test_the_exclusion_constraint_is_the_backstop_and_becomes_slot_unavailable() -> None:
    script = Script()
    script.raises[postgres._SQL_INSERT_APPOINTMENT] = pg_error(
        pg_errors.ExclusionViolation, postgres.CONSTRAINT_NO_OVERLAP
    )
    book, pool = scripted_book(script)

    with pytest.raises(SlotUnavailable) as raised:
        confirm_appointment(book, PROPOSAL, NOW)

    assert raised.value.__suppress_context__
    assert SECRET_TEXT not in str(raised.value)
    assert (pool.committed, pool.rolled_back) == (0, 1)


def test_a_proposal_unique_violation_replays_the_row_in_a_new_transaction() -> None:
    script = Script()
    script.raises[postgres._SQL_INSERT_APPOINTMENT] = pg_error(
        pg_errors.UniqueViolation, postgres.CONSTRAINT_PROPOSAL
    )
    # The first transaction finds nothing; the follow-up transaction finds the winner.
    script.one[postgres._SQL_APPOINTMENT_BY_PROPOSAL] = [None, CREATED_ROW]
    book, pool = scripted_book(script)

    appointment, created = confirm_appointment(book, PROPOSAL, NOW)

    assert not created and appointment.id == UUID(int=1)
    assert pool.rolled_back == 1 and pool.committed == 1  # aborted one, then a clean replay


def test_a_unique_violation_with_no_winning_row_is_a_storage_error() -> None:
    script = Script()
    script.raises[postgres._SQL_INSERT_APPOINTMENT] = pg_error(
        pg_errors.UniqueViolation, postgres.CONSTRAINT_PROPOSAL
    )
    script.one[postgres._SQL_APPOINTMENT_BY_PROPOSAL] = [None, None]
    book, _ = scripted_book(script)
    with pytest.raises(StorageUnavailable):
        confirm_appointment(book, PROPOSAL, NOW)


@pytest.mark.parametrize(
    "error",
    [
        pg_error(pg_errors.CheckViolation, "appointments_customer_alias_check"),
        pg_error(pg_errors.ForeignKeyViolation, "appointments_service_fk"),
        pg_error(pg_errors.UniqueViolation, "some_other_unique"),
        pg_error(pg_errors.ExclusionViolation, "some_other_exclusion"),
        pg_error(pg_errors.NotNullViolation),
    ],
    ids=lambda e: type(e).__name__,
)
def test_unexpected_integrity_errors_are_a_server_fault_without_detail(
    error: psycopg.Error, caplog: pytest.LogCaptureFixture
) -> None:
    script = Script()
    script.raises[postgres._SQL_INSERT_APPOINTMENT] = error
    book, pool = scripted_book(script)

    with caplog.at_level(logging.DEBUG), pytest.raises(DatabaseFault) as raised:
        confirm_appointment(book, PROPOSAL, NOW)

    assert raised.value.__suppress_context__
    assert SECRET_TEXT not in str(raised.value) + caplog.text
    assert pool.rolled_back == 1


def test_a_connection_error_during_insert_is_a_storage_error_and_never_leaks() -> None:
    script = Script()
    script.raises[postgres._SQL_INSERT_APPOINTMENT] = psycopg.OperationalError(SECRET_TEXT)
    book, pool = scripted_book(script)
    with pytest.raises(StorageUnavailable) as raised:
        confirm_appointment(book, PROPOSAL, NOW)
    assert SECRET_TEXT not in repr(raised.value)
    assert pool.rolled_back == 1


def test_an_unknown_business_is_a_logged_storage_error(caplog: pytest.LogCaptureFixture) -> None:
    script = Script()  # no business row scripted
    db, _ = make_db(script)
    with caplog.at_level(logging.ERROR), pytest.raises(StorageUnavailable):
        confirm_appointment(PostgresAppointmentBook(db, "test"), PROPOSAL, NOW)
    assert "no business" in caplog.text


def test_rows_are_converted_to_utc() -> None:
    from zoneinfo import ZoneInfo

    local = datetime(2026, 10, 6, 10, 0, tzinfo=ZoneInfo("America/New_York"))
    row = (*CREATED_ROW[:4], local, local + timedelta(minutes=30), *CREATED_ROW[6:])
    script = Script()
    script.one[postgres._SQL_APPOINTMENT_BY_ID] = [row]
    db, _ = make_db(script)
    appointment = PostgresAppointmentBook(db, "test").get(UUID(int=1))
    assert appointment is not None
    assert appointment.start == datetime(2026, 10, 6, 14, 0, tzinfo=UTC)
    assert appointment.start.utcoffset() == timedelta(0)


# --- day_view, bench numbering and connection settings ------------------------------------


def test_day_view_reads_the_catalog_and_the_days_bookings_in_one_transaction() -> None:
    script = Script()
    script.many[postgres._SQL_BOOKINGS_OVERLAPPING] = [
        [("flat-repair", START, START + timedelta(minutes=30), 2)]
    ]
    book, pool = scripted_book(script)

    snapshot, bookings = book.day_view("flat-repair", START)

    assert snapshot.business.id == "test" and snapshot.service is not None
    assert [(b.bench, b.start) for b in bookings] == [(2, START)]
    assert executed(script) == [
        postgres._SQL_PREAMBLE,
        postgres._SQL_BUSINESS_AND_SERVICE,
        postgres._SQL_HOURS,
        postgres._SQL_BOOKINGS_OVERLAPPING,
    ]
    assert (pool.committed, pool.rolled_back) == (1, 0)  # a single transaction
    start_param, end_param = script.calls[-1][1][1:]
    assert end_param - start_param == timedelta(hours=24)  # the local day around START


def test_day_view_accepts_a_local_date_as_well_as_an_instant() -> None:
    script = Script()
    book, _ = scripted_book(script)
    book.day_view("flat-repair", date(2026, 10, 6))
    start_param, _ = script.calls[-1][1][1:]
    assert start_param == datetime(2026, 10, 6, 4, 0, tzinfo=UTC)  # midnight EDT


def test_benches_numbered_with_a_gap_are_rejected_not_silently_misallocated(
    caplog: pytest.LogCaptureFixture,
) -> None:
    script = Script()
    gap = (*BUSINESS_ROW[:10], 2, *BUSINESS_ROW[11:17], 3)  # two benches, highest number 3
    script.one[postgres._SQL_BUSINESS_AND_SERVICE] = [gap]
    script.many[postgres._SQL_HOURS] = [HOURS_ROWS]
    db, _ = make_db(script)
    with caplog.at_level(logging.ERROR), pytest.raises(StorageUnavailable):
        PostgresCatalog(db, "test").snapshot("flat-repair")
    assert "could not be parsed" in caplog.text


def test_the_connection_sets_tcp_level_timeouts_and_never_a_password_in_the_conninfo() -> None:
    db = PostgresDatabase(make_settings())
    kwargs = db._pool.kwargs
    assert isinstance(kwargs, dict)
    assert kwargs["tcp_user_timeout"] == 5000
    assert kwargs["keepalives"] == 1
    assert kwargs["connect_timeout"] == 3
    assert kwargs["prepare_threshold"] is None
    assert kwargs["sslmode"] == "verify-full"
    assert db._pool.conninfo == ""  # nothing sensitive is baked into a DSN string


def test_replace_demo_data_inserts_seed_rows_from_the_catalog_with_snapshot_columns() -> None:
    script = Script()
    db, pool = make_db(script)
    from voice_agent_api.domain.models import Booking

    seed = Booking("flat-repair", START, START + timedelta(minutes=30), 1)
    PostgresAppointmentBook(db, "test").replace_demo_data([seed])

    delete_sql, delete_params = script.calls[1]
    insert_sql, insert_params = script.calls[2]
    assert delete_sql == postgres._SQL_DELETE_DEMO_APPOINTMENTS
    assert delete_params == ("test", ["seed", "web_demo"])
    assert insert_sql == postgres._SQL_INSERT_SEED_APPOINTMENT
    assert insert_params == (1, START, START + timedelta(minutes=30), "test", "flat-repair")
    assert "s.name, s.price_amount_minor, s.currency, b.timezone" in insert_sql
    assert pool.committed == 1
