"""Offline hygiene checks on the SQL migrations (no database needed).

The migrations themselves are only proven by running them (Supabase `db push`, then the
integration tests). These tests keep the rules that can be checked textually from regressing.
"""

import re
from pathlib import Path

import pytest

from voice_agent_api.infrastructure.seed import HOURS, SERVICES

MIGRATIONS = sorted((Path(__file__).resolve().parents[2] / "supabase" / "migrations").glob("*.sql"))
FIRST_STATEMENT = "set local search_path = pg_catalog, extensions;"


def code(path: Path) -> str:
    """The migration without `--` comments, lower-cased."""
    lines = (line.split("--", 1)[0] for line in path.read_text("utf-8").splitlines())
    return "\n".join(lines).lower()


def test_the_three_booking_migrations_exist_with_cli_generated_names() -> None:
    names = [p.name for p in MIGRATIONS]
    assert len(names) == 3
    assert all(re.fullmatch(r"\d{14}_[a-z_]+\.sql", n) for n in names)
    assert [n.split("_", 1)[1] for n in names] == [
        "booking_schema.sql",
        "booking_catalog_seed.sql",
        "booking_api_role.sql",
    ]


@pytest.mark.parametrize("path", MIGRATIONS, ids=lambda p: p.name)
def test_each_migration_pins_search_path_first(path: Path) -> None:
    assert code(path).strip().startswith(FIRST_STATEMENT)


@pytest.mark.parametrize("path", MIGRATIONS, ids=lambda p: p.name)
def test_migrations_contain_no_secrets_and_no_security_definer(path: Path) -> None:
    text = code(path)
    assert "password" not in text  # the role password is only ever set with psql \password
    assert "security definer" not in text
    assert "bypassrls" not in text.replace("nobypassrls", "")
    assert not re.search(
        r"grant\b[^;]*\bto\b[^;]*\b(anon|authenticated|service_role|public)\b", text
    )


def test_every_table_has_rls_enabled() -> None:
    text = code(MIGRATIONS[0])
    tables = re.findall(r"create table (booking\.\w+)", text)
    assert len(tables) == 5
    for table in tables:
        assert f"alter table {table} enable row level security" in text, table


def test_every_created_object_is_schema_qualified() -> None:
    text = code(MIGRATIONS[0])
    for statement in re.findall(
        r"create (?:table|function|index \w+ on|trigger \w+ before update on) (\S+)", text
    ):
        assert statement.startswith("booking."), statement
    assert "create trigger" in text
    assert "create schema booking" in text


def test_the_overlap_constraint_and_idempotency_key_are_defined_by_name() -> None:
    text = code(MIGRATIONS[0])
    assert "constraint appointments_no_bench_overlap" in text
    assert "exclude using gist (business_id with =, bench_no with =, during with &&)" in text
    assert "where (status = 'confirmed')" in text
    assert "constraint appointments_proposal_id_key unique (proposal_id)" in text
    assert "tstzrange(starts_at, ends_at, '[)')" in text  # half-open


def test_the_api_role_starts_unable_to_log_in_and_is_least_privilege() -> None:
    text = code(MIGRATIONS[2])
    assert "create role voice_agent_api nologin" in text
    assert "nosuperuser" in text and "nobypassrls" in text
    assert "grant insert, delete on booking.appointments to voice_agent_api" in text
    assert "grant update" not in text
    for table in ("businesses", "benches", "services", "opening_hours", "appointments"):
        assert f"booking.{table}" in text
    policies = re.findall(r"create policy \w+ on booking\.\w+\s+for \w+ to (\w+)", text)
    assert policies and set(policies) == {"voice_agent_api"}


def test_the_seed_migration_matches_the_in_memory_catalog() -> None:
    text = code(MIGRATIONS[1])
    for service in SERVICES:
        minutes = int(service.duration.total_seconds() // 60)
        assert f"'{service.id}'" in text
        assert f"'{service.name.lower()}'" in text
        assert (
            f"{minutes}, {service.price.amount_minor}, '{service.price.currency.lower()}'" in text
        )
    weekdays = {i.weekday for i in HOURS.intervals}
    assert weekdays == {1, 2, 3, 4, 5}
    assert "(1), (2), (3), (4)" in text and "'09:00'::time, '13:00'::time" in text


def test_appointments_store_a_snapshot_of_what_was_booked() -> None:
    text = code(MIGRATIONS[0])
    for column in (
        "service_name text not null",
        "price_amount_minor integer not null",
        "price_currency char(3) not null",
        "timezone text not null",
    ):
        assert column in text, column


def test_the_fictional_phone_check_uses_the_reserved_555_01xx_range() -> None:
    text = code(MIGRATIONS[0])
    assert "555-01[0-9]{2}" in text
    assert "555-[0-9]{4}" not in text
    seed = code(MIGRATIONS[1])
    assert re.search(r"\+1 [0-9]{3}-555-01[0-9]{2}", seed)


def test_role_level_limits_match_the_application_limits() -> None:
    text = code(MIGRATIONS[2])
    assert "set statement_timeout = '1s'" in text
    assert "set lock_timeout = '1s'" in text
    assert "set idle_in_transaction_session_timeout = '5s'" in text
