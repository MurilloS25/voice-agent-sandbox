"""The PostgreSQL ledger against a scripted database (no connection), and the migration's text."""

import re
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from psycopg import errors as pg_errors

from voice_agent_api.budget.errors import BudgetUnavailable
from voice_agent_api.budget.ledger import BudgetCategory
from voice_agent_api.domain.errors import StorageUnavailable
from voice_agent_api.infrastructure import postgres
from voice_agent_api.infrastructure.postgres import PostgresBudgetLedger

DAY = date(2026, 10, 6)
MIGRATION = next(
    (Path(__file__).resolve().parents[2] / "supabase" / "migrations").glob("*_provider_budget.sql")
)


class FakeCursor:
    def __init__(self, reserved: bool) -> None:
        self.calls: list[tuple[str, tuple[Any, ...]]] = []
        self._reserved = reserved

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> None:
        self.calls.append((sql, params))

    def fetchone(self) -> tuple[int] | None:
        return (1,) if self._reserved else None


class FakeDatabase:
    def __init__(self, *, reserved: bool = True, fail: BaseException | None = None) -> None:
        self.cursor = FakeCursor(reserved)
        self.transactions = 0
        self._fail = fail

    @contextmanager
    def transaction(self) -> Iterator[FakeCursor]:
        self.transactions += 1
        if self._fail is not None:
            raise self._fail
        yield self.cursor


def ledger(db: FakeDatabase) -> PostgresBudgetLedger:
    return PostgresBudgetLedger(db)  # type: ignore[arg-type]


def test_a_reservation_is_one_transaction_with_two_statements_and_bound_parameters() -> None:
    db = FakeDatabase()
    assert ledger(db).reserve(DAY, BudgetCategory.AGENT_TOKENS, 400, 100_000) is True
    assert db.transactions == 1
    (first, p1), (second, p2) = db.cursor.calls
    assert first == postgres._SQL_BUDGET_ROW and p1 == (DAY, "agent_tokens", 100_000)
    assert second == postgres._SQL_BUDGET_RESERVE
    assert p2 == (400, 100_000, DAY, "agent_tokens", 400, 100_000)


def test_the_reservation_statement_is_atomic_and_cannot_pass_the_limit() -> None:
    sql = postgres._SQL_BUDGET_RESERVE.lower()
    assert sql.startswith("update booking.provider_budget set consumed = consumed + %s")
    assert "consumed + %s <= %s" in sql and "returning consumed" in sql
    assert "select" not in sql  # no read-then-write: the check and the change are one statement


def test_a_reservation_that_would_pass_the_limit_is_reported_not_raised() -> None:
    assert (
        ledger(FakeDatabase(reserved=False)).reserve(DAY, BudgetCategory.SPEECH_SECONDS, 90, 100)
        is False
    )


def test_adjusting_binds_the_signed_amount_and_never_goes_below_zero() -> None:
    db = FakeDatabase()
    ledger(db).adjust(DAY, BudgetCategory.AGENT_TOKENS, -250)
    ((sql, params),) = db.cursor.calls
    assert sql == postgres._SQL_BUDGET_ADJUST
    assert params == (-250, -250, DAY, "agent_tokens")
    assert "case when consumed + %s < 0 then 0" in sql


@pytest.mark.parametrize("failure", [StorageUnavailable(), pg_errors.OperationalError("x SECRET")])
def test_any_database_failure_becomes_budget_unavailable(failure: BaseException) -> None:
    db = FakeDatabase(fail=failure)
    with pytest.raises(BudgetUnavailable) as caught:
        ledger(db).reserve(DAY, BudgetCategory.AGENT_TOKENS, 1, 10)
    with pytest.raises(BudgetUnavailable):
        ledger(db).adjust(DAY, BudgetCategory.AGENT_TOKENS, 1)
    assert "SECRET" not in str(caught.value)


def test_the_ledger_writes_numbers_only() -> None:
    sql = " ".join(
        [postgres._SQL_BUDGET_ROW, postgres._SQL_BUDGET_RESERVE, postgres._SQL_BUDGET_ADJUST]
    )
    assert set(re.findall(r"\b(day_utc|category|consumed|limit_amount|updated_at)\b", sql)) == {
        "day_utc",
        "category",
        "consumed",
        "limit_amount",
        "updated_at",
    }


# --- the migration (text only; it is never applied here) ----------------------------------------


def code() -> str:
    lines = (line.split("--", 1)[0] for line in MIGRATION.read_text("utf-8").splitlines())
    return "\n".join(lines).lower()


def test_the_table_holds_only_aggregate_columns() -> None:
    text = code()
    body = text[text.index("create table booking.provider_budget") :]
    body = body[: body.index(");")]
    columns = re.findall(r"^\s*([a-z_]+) (?:date|text|bigint|timestamptz)\b", body, re.MULTILINE)
    assert columns == ["day_utc", "category", "consumed", "limit_amount", "updated_at"]
    for forbidden in ("visitor", "client", "ip", "hash", "text_", "message", "audio", "transcript"):
        assert not any(forbidden == column for column in columns)


def test_it_lives_in_the_private_schema_and_never_in_public() -> None:
    text = code()
    assert "booking.provider_budget" in text
    assert "public." not in text and "create schema" not in text
    assert text.strip().startswith("set local search_path = pg_catalog, extensions;")


def test_rls_is_on_and_the_only_policies_are_for_the_api_role() -> None:
    text = code()
    assert "alter table booking.provider_budget enable row level security;" in text
    policies = re.findall(
        r"create policy \w+ on booking\.provider_budget\s+for (\w+) to (\w+)", text
    )
    assert sorted(policies) == [
        ("insert", "voice_agent_api"),
        ("select", "voice_agent_api"),
        ("update", "voice_agent_api"),
    ]


def test_grants_are_exactly_what_the_backend_needs_and_nothing_else() -> None:
    text = code()
    grants = re.findall(r"grant ([^;]+?) on booking\.provider_budget to (\w+);", text)
    assert grants == [
        ("select, insert", "voice_agent_api"),
        ("update (consumed, limit_amount, updated_at)", "voice_agent_api"),
    ]
    assert "delete" not in " ".join(g[0] for g in grants)


def test_other_roles_are_revoked_and_never_granted() -> None:
    text = code()
    assert "revoke all on booking.provider_budget from public;" in text
    assert "revoke all on booking.provider_budget from anon, authenticated, service_role;" in text
    assert not re.search(
        r"grant\b[^;]*\bto\b[^;]*\b(anon|authenticated|service_role|public)\b", text
    )


def test_no_security_definer_no_drop_no_password_no_data_change() -> None:
    text = code()
    for forbidden in (
        "security definer",
        "drop ",
        "truncate",
        "delete from",
        "password",
        "insert into",
    ):
        assert forbidden not in text
    assert text.count("create table") == 1


def test_the_category_and_the_numbers_are_constrained() -> None:
    text = code()
    assert "check (category in ('agent_tokens', 'speech_seconds'))" in text
    assert "check (consumed >= 0)" in text and "check (limit_amount >= 0)" in text
    assert "primary key (day_utc, category)" in text
