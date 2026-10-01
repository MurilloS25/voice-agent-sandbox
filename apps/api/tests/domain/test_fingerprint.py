import hmac
from dataclasses import replace
from datetime import timedelta
from zoneinfo import ZoneInfo

import pytest

from tests.support import FLAT_REPAIR, make_business
from voice_agent_api.domain.fingerprint import catalog_fingerprint, fingerprints_match
from voice_agent_api.domain.models import Money

BUSINESS = make_business()


def test_fingerprint_is_compact_and_stable() -> None:
    first = catalog_fingerprint(BUSINESS, FLAT_REPAIR)
    assert first == catalog_fingerprint(BUSINESS, FLAT_REPAIR)
    assert len(first) == 22
    assert set(first) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")


def test_fingerprint_known_answer() -> None:
    # Pinned so the canonical form cannot drift silently between versions or platforms.
    assert catalog_fingerprint(BUSINESS, FLAT_REPAIR) == "9Cgz8mXx8nDhxsteH3Ko6Q"


@pytest.mark.parametrize(
    ("business_change", "service_change"),
    [
        ({"id": "other"}, {}),
        ({"timezone": ZoneInfo("America/Chicago")}, {}),
        ({"currency": "EUR"}, {}),
        ({}, {"id": "other-service"}),
        ({}, {"name": "Flat fix"}),
        ({}, {"duration": timedelta(minutes=45)}),
        ({}, {"price": Money(1600, "USD")}),
        ({}, {"price": Money(1500, "EUR")}),
    ],
)
def test_every_reviewed_value_changes_the_fingerprint(
    business_change: dict[str, object], service_change: dict[str, object]
) -> None:
    changed = catalog_fingerprint(
        replace(BUSINESS, **business_change),  # type: ignore[arg-type]
        replace(FLAT_REPAIR, **service_change),  # type: ignore[arg-type]
    )
    assert changed != catalog_fingerprint(BUSINESS, FLAT_REPAIR)


@pytest.mark.parametrize(
    "business_change",
    [
        {"name": "Renamed shop"},
        {"bench_capacity": 3},
        {"slot_interval": timedelta(minutes=15)},
        {"min_lead_time": timedelta(hours=1)},
        {"booking_horizon": timedelta(days=30)},
    ],
)
def test_values_that_check_slot_revalidates_do_not_change_the_fingerprint(
    business_change: dict[str, object],
) -> None:
    same = catalog_fingerprint(replace(BUSINESS, **business_change), FLAT_REPAIR)  # type: ignore[arg-type]
    assert same == catalog_fingerprint(BUSINESS, FLAT_REPAIR)


def test_description_is_not_part_of_the_review() -> None:
    reworded = replace(FLAT_REPAIR, description="Completely different words.")
    assert catalog_fingerprint(BUSINESS, reworded) == catalog_fingerprint(BUSINESS, FLAT_REPAIR)


def test_comparison_uses_a_constant_time_compare(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[bytes, bytes]] = []
    real = hmac.compare_digest

    def spy(a: bytes, b: bytes) -> bool:
        calls.append((a, b))
        return bool(real(a, b))

    monkeypatch.setattr(hmac, "compare_digest", spy)
    assert fingerprints_match("abc", "abc")
    assert not fingerprints_match("abc", "abd")
    assert len(calls) == 2
