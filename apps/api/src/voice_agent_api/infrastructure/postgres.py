"""PostgreSQL adapter: psycopg 3 with a synchronous connection pool.

Rules this module follows (tests enforce the mechanical ones):

- Blocking: nothing here may run on the asyncio event loop. Routes and dependencies that reach
  it are plain `def`, and the lifespan opens and closes the pool through the threadpool.
- Every statement is a module-level `LiteralString` constant with `%s` placeholders. Nothing is
  interpolated into SQL, and there are no dynamic identifiers.
- Every table and function is schema-qualified (`booking.*`, `pg_catalog.*`), and each
  transaction starts by pinning `search_path` instead of inheriting the connection default.
- psycopg errors never escape this module unmapped. Their messages can hold hostnames, role
  names, SQL and key values, so they are logged by class and SQLSTATE only and replaced by
  fixed-message domain errors, raised `from None`.
"""

import hashlib
import logging
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, LiteralString
from uuid import UUID
from zoneinfo import ZoneInfo

import psycopg
from psycopg import errors as pg_errors
from psycopg_pool import ConnectionPool

from voice_agent_api.budget.errors import BudgetUnavailable
from voice_agent_api.budget.ledger import BudgetCategory
from voice_agent_api.config import Settings
from voice_agent_api.domain.availability import local_day_bounds, local_day_of
from voice_agent_api.domain.errors import SlotUnavailable, StorageUnavailable
from voice_agent_api.domain.models import (
    Appointment,
    Booking,
    Business,
    CatalogSnapshot,
    Money,
    OpeningInterval,
    Proposal,
    Service,
    WeeklyHours,
)
from voice_agent_api.domain.ports import Decide

logger = logging.getLogger("voice_agent_api")

CONSTRAINT_NO_OVERLAP = "appointments_no_bench_overlap"
CONSTRAINT_PROPOSAL = "appointments_proposal_id_key"
_DEMO_SOURCES = ["seed", "web_demo"]
_OPEN_TIMEOUT_S = 10.0
_CLOSE_TIMEOUT_S = 5.0
_POOL_MAX_LIFETIME_S = 1800.0
_POOL_RECONNECT_TIMEOUT_S = 30.0

_SQL_PREAMBLE: LiteralString = (
    "select pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true), "
    "pg_catalog.set_config('statement_timeout', %s, true), "
    "pg_catalog.set_config('lock_timeout', %s, true), "
    "pg_catalog.set_config('idle_in_transaction_session_timeout', %s, true)"
)
_SQL_PING: LiteralString = "select 1"
_SQL_LOCK_DAY: LiteralString = "select pg_catalog.pg_advisory_xact_lock(%s::bigint)"

_SQL_BUSINESS_AND_SERVICE: LiteralString = (
    "select b.id, b.name, b.tagline, b.address, b.phone, b.timezone, b.currency, "
    "b.slot_interval_minutes, b.min_lead_minutes, b.booking_horizon_days, "
    "(select pg_catalog.count(*) from booking.benches n where n.business_id = b.id), "
    "s.id, s.name, s.description, s.duration_minutes, s.price_amount_minor, s.currency, "
    "(select pg_catalog.max(n.bench_no) from booking.benches n where n.business_id = b.id) "
    "from booking.businesses b "
    "left join booking.services s on s.business_id = b.id and s.id = %s "
    "where b.id = %s"
)
_SQL_HOURS: LiteralString = (
    "select h.weekday, h.opens_at, h.closes_at from booking.opening_hours h "
    "where h.business_id = %s order by h.weekday, h.opens_at"
)
_SQL_SERVICES: LiteralString = (
    "select s.id, s.name, s.description, s.duration_minutes, s.price_amount_minor, s.currency "
    "from booking.services s where s.business_id = %s order by s.duration_minutes, s.id"
)
_SQL_SERVICE_BY_ID: LiteralString = (
    "select s.id, s.name, s.description, s.duration_minutes, s.price_amount_minor, s.currency "
    "from booking.services s where s.business_id = %s and s.id = %s"
)

_APPOINTMENT_COLUMNS: LiteralString = (
    "a.id, a.business_id, a.service_id, a.bench_no, a.starts_at, a.ends_at, a.status, "
    "a.customer_alias, a.source, a.proposal_id, a.created_at, a.updated_at, "
    "a.service_name, a.price_amount_minor, a.price_currency, a.timezone"
)
_SQL_BOOKINGS_OVERLAPPING: LiteralString = (
    "select a.service_id, a.starts_at, a.ends_at, a.bench_no from booking.appointments a "
    "where a.business_id = %s and a.status = 'confirmed' "
    "and a.during && pg_catalog.tstzrange(%s, %s, '[)')"
)
_SQL_APPOINTMENT_BY_PROPOSAL: LiteralString = (
    "select " + _APPOINTMENT_COLUMNS + " from booking.appointments a where a.proposal_id = %s"
)
_SQL_APPOINTMENT_BY_ID: LiteralString = (
    "select " + _APPOINTMENT_COLUMNS + " from booking.appointments a where a.id = %s"
)
_SQL_INSERT_APPOINTMENT: LiteralString = (
    "insert into booking.appointments as a "
    "(business_id, service_id, bench_no, starts_at, ends_at, status, customer_alias, "
    "source, proposal_id, service_name, price_amount_minor, price_currency, timezone) "
    "values (%s, %s, %s, %s, %s, 'confirmed', %s, %s, %s, %s, %s, %s, %s) "
    "returning " + _APPOINTMENT_COLUMNS
)
_SQL_DELETE_DEMO_APPOINTMENTS: LiteralString = (
    "delete from booking.appointments where business_id = %s and source = any(%s)"
)
_SQL_INSERT_SEED_APPOINTMENT: LiteralString = (
    "insert into booking.appointments "
    "(business_id, service_id, bench_no, starts_at, ends_at, status, customer_alias, source, "
    "service_name, price_amount_minor, price_currency, timezone) "
    "select b.id, s.id, %s, %s, %s, 'confirmed', 'Demo Seed Booking', 'seed', "
    "s.name, s.price_amount_minor, s.currency, b.timezone "
    "from booking.businesses b join booking.services s on s.business_id = b.id "
    "where b.id = %s and s.id = %s"
)


class DatabaseFault(Exception):
    """A database constraint was violated in a way the code did not expect (a server bug)."""

    def __init__(self) -> None:
        super().__init__("A database rule was violated unexpectedly.")


def day_lock_key(business_id: str, local_date: date) -> int:
    """A deterministic key in PostgreSQL's signed bigint range for one business-local day.

    BLAKE2b with an 8-byte digest read as a two's-complement integer covers exactly
    [-2**63, 2**63 - 1]. Python's randomized `hash()` is never used. A collision with another
    lock user could only add waiting; correctness rests on the exclusion constraint.
    """
    digest = hashlib.blake2b(
        f"{business_id}\x1f{local_date.isoformat()}".encode(), digest_size=8, person=b"va-daylock"
    ).digest()
    return int.from_bytes(digest, "big", signed=True)


def _storage_unavailable(exc: BaseException) -> StorageUnavailable:
    logger.warning(
        "Storage failure: %s (sqlstate=%s)", type(exc).__name__, getattr(exc, "sqlstate", None)
    )
    return StorageUnavailable()


Cursor = psycopg.Cursor[tuple[Any, ...]]


class PostgresDatabase:
    """The pool plus the single place where a transaction (and its cursor) is created."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        password = settings.db_password
        kwargs: dict[str, Any] = {
            "host": settings.db_host,
            "port": settings.db_port,
            "dbname": settings.db_name,
            "user": settings.db_user,
            "password": password.get_secret_value() if password else None,
            "sslmode": settings.db_sslmode,
            "connect_timeout": settings.db_connect_timeout_s,
            "application_name": "voice-agent-api",
            # TCP-level limits: statement_timeout is server-side, so on a network that drops
            # packets silently a worker would otherwise block for the OS default (minutes).
            "keepalives": 1,
            "keepalives_idle": 10,
            "keepalives_interval": 5,
            "keepalives_count": 2,
            "tcp_user_timeout": 5000,
            # Safe behind a transaction pooler too, should we ever move to one.
            "prepare_threshold": None,
        }
        if settings.db_sslrootcert:
            kwargs["sslrootcert"] = settings.db_sslrootcert
        self._pool = ConnectionPool(
            conninfo="",
            kwargs=kwargs,
            min_size=1,
            max_size=settings.db_pool_max,
            timeout=settings.db_pool_timeout_s,
            max_waiting=settings.db_pool_max_waiting,
            max_lifetime=_POOL_MAX_LIFETIME_S,
            reconnect_timeout=_POOL_RECONNECT_TIMEOUT_S,
            check=ConnectionPool.check_connection,
            name="voice-agent-api",
            open=False,
        )

    def open(self) -> None:
        """Open the pool and prove it works. Blocking: call from the threadpool."""
        try:
            self._pool.open(wait=True, timeout=_OPEN_TIMEOUT_S)
            with self.transaction() as cur:
                cur.execute(_SQL_PING)
                cur.fetchone()
        except psycopg.Error as exc:
            self._pool.close(timeout=_CLOSE_TIMEOUT_S)
            raise _storage_unavailable(exc) from None
        except StorageUnavailable:
            self._pool.close(timeout=_CLOSE_TIMEOUT_S)
            raise

    def close(self) -> None:
        self._pool.close(timeout=_CLOSE_TIMEOUT_S)

    def ping(self) -> bool:
        """True when the database answers a minimal query. Never raises, never says why not."""
        try:
            with self.transaction() as cur:
                cur.execute(_SQL_PING)
                cur.fetchone()
        except (StorageUnavailable, pg_errors.Error):
            return False
        return True

    @contextmanager
    def transaction(self) -> Iterator[Cursor]:
        """One transaction: commits on success, rolls back on any exception.

        Integrity errors propagate unmapped (after the rollback) so callers can interpret the
        constraint. Every other psycopg or pool error becomes `StorageUnavailable`. Domain
        errors raised by the body pass through untouched.
        """
        s = self._settings
        try:
            with self._pool.connection() as conn, conn.cursor() as cur:
                cur.execute(
                    _SQL_PREAMBLE,
                    (
                        str(s.db_statement_timeout_ms),
                        str(s.db_lock_timeout_ms),
                        str(s.db_idle_in_transaction_timeout_ms),
                    ),
                )
                yield cur
        except pg_errors.IntegrityError:
            raise
        except psycopg.Error as exc:
            raise _storage_unavailable(exc) from None


def _service(row: Sequence[Any]) -> Service:
    return Service(
        id=row[0],
        name=row[1],
        description=row[2],
        duration=timedelta(minutes=row[3]),
        price=Money(amount_minor=row[4], currency=row[5]),
    )


def _business(row: Sequence[Any]) -> Business:
    return Business(
        id=row[0],
        name=row[1],
        tagline=row[2],
        address=row[3],
        phone=row[4],
        timezone=ZoneInfo(row[5]),
        currency=row[6],
        bench_capacity=int(row[10]),
        slot_interval=timedelta(minutes=row[7]),
        min_lead_time=timedelta(minutes=row[8]),
        booking_horizon=timedelta(days=row[9]),
    )


def _hours(rows: Sequence[Sequence[Any]]) -> WeeklyHours:
    intervals: list[OpeningInterval] = []
    for weekday, opens_at, closes_at in rows:
        assert isinstance(opens_at, time) and isinstance(closes_at, time)
        intervals.append(OpeningInterval(int(weekday), opens_at, closes_at))
    return WeeklyHours(tuple(intervals))


def _appointment(row: Sequence[Any]) -> Appointment:
    return Appointment(
        id=row[0],
        business_id=row[1],
        service_id=row[2],
        bench=int(row[3]),
        start=row[4].astimezone(UTC),
        end=row[5].astimezone(UTC),
        status=row[6],
        customer_alias=row[7],
        source=row[8],
        proposal_id=row[9],
        created_at=row[10].astimezone(UTC),
        updated_at=row[11].astimezone(UTC),
        service_name=row[12],
        price=Money(amount_minor=int(row[13]), currency=row[14]),
        timezone=row[15],
    )


def _load_snapshot(cur: Cursor, business_id: str, service_id: str | None) -> CatalogSnapshot:
    cur.execute(_SQL_BUSINESS_AND_SERVICE, (service_id, business_id))
    row = cur.fetchone()
    if row is None:
        logger.error("Catalog has no business with the configured id")
        raise StorageUnavailable
    cur.execute(_SQL_HOURS, (business_id,))
    hours_rows = cur.fetchall()
    try:
        if row[17] != row[10]:
            # free_bench assigns benches 1..N, so a gap would break allocation.
            raise ValueError("benches must be numbered 1..N")
        business = _business(row)
        service = _service(row[11:17]) if row[11] is not None else None
        hours = _hours(hours_rows)
    except (ValueError, KeyError, TypeError, AssertionError):
        logger.error("Catalog rows could not be parsed")
        raise StorageUnavailable from None
    return CatalogSnapshot(business=business, hours=hours, service=service)


class PostgresCatalog:
    """Reads the current catalog rows on every call. Nothing is cached."""

    def __init__(self, database: PostgresDatabase, business_id: str) -> None:
        self._db = database
        self._business_id = business_id

    def snapshot(self, service_id: str | None = None) -> CatalogSnapshot:
        with self._db.transaction() as cur:
            return _load_snapshot(cur, self._business_id, service_id)

    def business(self) -> Business:
        return self.snapshot().business

    def hours(self) -> WeeklyHours:
        return self.snapshot().hours

    def services(self) -> Sequence[Service]:
        with self._db.transaction() as cur:
            cur.execute(_SQL_SERVICES, (self._business_id,))
            return tuple(_service(row) for row in cur.fetchall())

    def service_by_id(self, service_id: str) -> Service | None:
        with self._db.transaction() as cur:
            cur.execute(_SQL_SERVICE_BY_ID, (self._business_id, service_id))
            row = cur.fetchone()
            return _service(row) if row is not None else None


class PostgresAppointmentBook:
    def __init__(self, database: PostgresDatabase, business_id: str) -> None:
        self._db = database
        self._business_id = business_id

    def bookings_overlapping(self, start: datetime, end: datetime) -> Sequence[Booking]:
        with self._db.transaction() as cur:
            return _bookings(cur, self._business_id, start, end)

    def day_view(
        self, service_id: str, when: date | datetime
    ) -> tuple[CatalogSnapshot, Sequence[Booking]]:
        """The catalog snapshot and the day's bookings from one transaction."""
        with self._db.transaction() as cur:
            snapshot = _load_snapshot(cur, self._business_id, service_id)
            day_start, day_end = local_day_bounds(
                snapshot.business, local_day_of(snapshot.business, when)
            )
            return snapshot, _bookings(cur, snapshot.business.id, day_start, day_end)

    def get(self, appointment_id: UUID) -> Appointment | None:
        with self._db.transaction() as cur:
            cur.execute(_SQL_APPOINTMENT_BY_ID, (appointment_id,))
            row = cur.fetchone()
            return _appointment(row) if row is not None else None

    def confirm(self, proposal: Proposal, decide: Decide) -> tuple[Appointment, bool]:
        try:
            return self._confirm_once(proposal, decide)
        except pg_errors.IntegrityError as exc:
            # The transaction has already been rolled back. Never reuse it.
            return self._after_integrity_error(exc, proposal)

    def _confirm_once(self, proposal: Proposal, decide: Decide) -> tuple[Appointment, bool]:
        with self._db.transaction() as cur:
            snapshot = _load_snapshot(cur, self._business_id, proposal.service_id)
            local_date = local_day_of(snapshot.business, proposal.start)
            cur.execute(_SQL_LOCK_DAY, (day_lock_key(snapshot.business.id, local_date),))

            cur.execute(_SQL_APPOINTMENT_BY_PROPOSAL, (proposal.id,))
            existing = cur.fetchone()
            if existing is not None:
                return _appointment(existing), False

            day_start, day_end = local_day_bounds(snapshot.business, local_date)
            bookings = _bookings(cur, snapshot.business.id, day_start, day_end)
            new = decide(snapshot, bookings)

            cur.execute(
                _SQL_INSERT_APPOINTMENT,
                (
                    new.business_id,
                    new.service_id,
                    new.bench,
                    new.start,
                    new.end,
                    new.customer_alias,
                    new.source,
                    new.proposal_id,
                    new.service_name,
                    new.price.amount_minor,
                    new.price.currency,
                    new.timezone,
                ),
            )
            row = cur.fetchone()
            if row is None:
                raise DatabaseFault
            return _appointment(row), True

    def _after_integrity_error(
        self, exc: pg_errors.IntegrityError, proposal: Proposal
    ) -> tuple[Appointment, bool]:
        sqlstate = exc.sqlstate
        constraint = exc.diag.constraint_name
        if sqlstate == "23P01" and constraint == CONSTRAINT_NO_OVERLAP:
            raise SlotUnavailable from None
        if sqlstate == "23505" and constraint == CONSTRAINT_PROPOSAL:
            # A concurrent request created it first: return the original (a replay).
            with self._db.transaction() as cur:
                cur.execute(_SQL_APPOINTMENT_BY_PROPOSAL, (proposal.id,))
                row = cur.fetchone()
            if row is None:
                raise _storage_unavailable(exc) from None
            return _appointment(row), False
        logger.error(
            "Unexpected integrity error: %s (sqlstate=%s, constraint=%s)",
            type(exc).__name__,
            sqlstate,
            constraint,
        )
        raise DatabaseFault from None

    def replace_demo_data(self, bookings: Sequence[Booking]) -> int:
        """Delete demo-owned rows and insert fresh seed bookings. Used by `demo_reset` only.

        Returns the number of rows deleted.
        """
        try:
            with self._db.transaction() as cur:
                cur.execute(_SQL_DELETE_DEMO_APPOINTMENTS, (self._business_id, _DEMO_SOURCES))
                deleted = cur.rowcount
                for booking in bookings:
                    cur.execute(
                        _SQL_INSERT_SEED_APPOINTMENT,
                        (
                            booking.bench,
                            booking.start,
                            booking.end,
                            self._business_id,
                            booking.service_id,
                        ),
                    )
                return deleted
        except pg_errors.IntegrityError as exc:
            logger.error("Demo reset hit a constraint: %s", type(exc).__name__)
            raise DatabaseFault from None


def _bookings(cur: Cursor, business_id: str, start: datetime, end: datetime) -> list[Booking]:
    cur.execute(_SQL_BOOKINGS_OVERLAPPING, (business_id, start, end))
    return [
        Booking(
            service_id=row[0],
            start=row[1].astimezone(UTC),
            end=row[2].astimezone(UTC),
            bench=int(row[3]),
        )
        for row in cur.fetchall()
    ]


def build_postgres(
    settings: Settings,
) -> tuple[PostgresCatalog, PostgresAppointmentBook, PostgresDatabase]:
    """Wire the adapter. Creates the pool but does not open it: the lifespan does that."""
    database = PostgresDatabase(settings)
    return (
        PostgresCatalog(database, settings.business_id),
        PostgresAppointmentBook(database, settings.business_id),
        database,
    )


_SQL_BUDGET_ROW: LiteralString = (
    "insert into booking.provider_budget (day_utc, category, consumed, limit_amount) "
    "values (%s, %s, 0, %s) on conflict (day_utc, category) do nothing"
)
# One atomic statement: the row is locked by the update, so two requests cannot both pass the
# check. It affects no row (and returns nothing) when the reservation would pass the limit.
_SQL_BUDGET_RESERVE: LiteralString = (
    "update booking.provider_budget set consumed = consumed + %s, limit_amount = %s, "
    "updated_at = pg_catalog.now() "
    "where day_utc = %s and category = %s and consumed + %s <= %s returning consumed"
)
_SQL_BUDGET_ADJUST: LiteralString = (
    "update booking.provider_budget set consumed = "
    "case when consumed + %s < 0 then 0 else consumed + %s end, "
    "updated_at = pg_catalog.now() where day_utc = %s and category = %s"
)


class PostgresBudgetLedger:
    """The daily provider budget in `booking.provider_budget`: a day, a category and two numbers.

    A failure of any kind becomes `BudgetUnavailable`, so the caller refuses the costly call."""

    def __init__(self, database: PostgresDatabase) -> None:
        self._database = database

    def reserve(self, day: date, category: BudgetCategory, amount: int, limit: int) -> bool:
        try:
            with self._database.transaction() as cur:
                cur.execute(_SQL_BUDGET_ROW, (day, category.value, limit))
                cur.execute(
                    _SQL_BUDGET_RESERVE, (amount, limit, day, category.value, amount, limit)
                )
                return cur.fetchone() is not None
        except (StorageUnavailable, pg_errors.Error):
            raise BudgetUnavailable from None

    def adjust(self, day: date, category: BudgetCategory, delta: int) -> None:
        try:
            with self._database.transaction() as cur:
                cur.execute(_SQL_BUDGET_ADJUST, (delta, delta, day, category.value))
        except (StorageUnavailable, pg_errors.Error):
            raise BudgetUnavailable from None
