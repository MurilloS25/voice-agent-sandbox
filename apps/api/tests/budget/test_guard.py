"""The budget guard and its ledgers: reservation, settlement, refunds, UTC days, fail closed."""

import threading
from datetime import UTC, date, datetime, timedelta

import pytest

from voice_agent_api.budget.errors import BudgetExhausted, BudgetUnavailable
from voice_agent_api.budget.guard import BudgetGuard
from voice_agent_api.budget.ledger import BudgetCategory, InMemoryBudgetLedger
from voice_agent_api.config import Settings

DAY = date(2026, 10, 6)
NOON = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)


class FailingLedger:
    def reserve(self, day: date, category: BudgetCategory, amount: int, limit: int) -> bool:
        raise RuntimeError("database down: SECRET-DETAIL")

    def adjust(self, day: date, category: BudgetCategory, delta: int) -> None:
        raise RuntimeError("database down: SECRET-DETAIL")


def guard(
    ledger: object,
    clock: object | None = None,
    *,
    tokens: int = 1000,
    reserve: int = 400,
    seconds: int = 100,
    min_billed: int = 10,
    bps: int = 3000,
) -> BudgetGuard:
    return BudgetGuard(
        ledger,  # type: ignore[arg-type]
        clock or (lambda: NOON),  # type: ignore[arg-type]
        agent_daily_tokens=tokens,
        agent_turn_reserve=reserve,
        speech_daily_seconds=seconds,
        speech_min_billed_seconds=min_billed,
        speech_min_bytes_per_second=bps,
    )


def test_a_reservation_is_taken_before_the_call_and_stops_at_the_limit() -> None:
    ledger = InMemoryBudgetLedger()
    g = guard(ledger)
    g.reserve_agent_turn()
    g.reserve_agent_turn()
    assert ledger.used(DAY, BudgetCategory.AGENT_TOKENS) == 800
    with pytest.raises(BudgetExhausted):
        g.reserve_agent_turn()  # 1,200 would pass the 1,000 limit
    assert ledger.used(DAY, BudgetCategory.AGENT_TOKENS) == 800  # a refusal reserves nothing


def test_settling_replaces_the_reservation_by_the_real_amount() -> None:
    ledger = InMemoryBudgetLedger()
    g = guard(ledger)
    reservation = g.reserve_agent_turn()
    g.settle(reservation, 150)  # cheaper than reserved: the difference is given back
    assert ledger.used(DAY, BudgetCategory.AGENT_TOKENS) == 150
    second = g.reserve_agent_turn()
    g.settle(second, 900)  # dearer than reserved: the overshoot is recorded
    assert ledger.used(DAY, BudgetCategory.AGENT_TOKENS) == 1050


def test_a_refund_gives_the_whole_reservation_back_and_never_goes_below_zero() -> None:
    ledger = InMemoryBudgetLedger()
    g = guard(ledger)
    reservation = g.reserve_agent_turn()
    g.refund(reservation)
    g.refund(reservation)  # a repeated refund cannot create credit
    assert ledger.used(DAY, BudgetCategory.AGENT_TOKENS) == 0


def test_the_overshoot_blocks_the_next_reservation() -> None:
    ledger = InMemoryBudgetLedger()
    g = guard(ledger)
    g.settle(g.reserve_agent_turn(), 1100)
    with pytest.raises(BudgetExhausted):
        g.reserve_agent_turn()


def test_the_day_is_utc_and_a_new_day_starts_empty() -> None:
    ledger = InMemoryBudgetLedger()
    now = {"t": datetime(2026, 10, 6, 23, 59, tzinfo=UTC)}
    g = guard(ledger, lambda: now["t"])
    g.reserve_agent_turn()
    g.reserve_agent_turn()
    with pytest.raises(BudgetExhausted):
        g.reserve_agent_turn()
    now["t"] = now["t"] + timedelta(minutes=2)  # 00:01 UTC on the next day
    g.reserve_agent_turn()
    assert ledger.used(date(2026, 10, 7), BudgetCategory.AGENT_TOKENS) == 400


def test_a_clock_in_another_zone_still_counts_the_utc_day() -> None:
    from zoneinfo import ZoneInfo

    ledger = InMemoryBudgetLedger()
    local = datetime(2026, 10, 6, 21, 0, tzinfo=ZoneInfo("America/New_York"))  # 01:00 UTC next day
    guard(ledger, lambda: local).reserve_agent_turn()
    assert ledger.used(date(2026, 10, 7), BudgetCategory.AGENT_TOKENS) == 400


@pytest.mark.parametrize(
    ("size", "charged"),
    [(0, 10), (1, 10), (30_000, 10), (30_001, 11), (60_000, 20), (262_144, 88)],
)
def test_audio_is_charged_the_larger_of_the_minimum_and_its_worst_case_length(
    size: int, charged: int
) -> None:
    assert guard(InMemoryBudgetLedger()).speech_charge(size) == charged


def test_speech_has_its_own_category_and_limit() -> None:
    ledger = InMemoryBudgetLedger()
    g = guard(ledger, seconds=25)
    g.reserve_speech(1000)
    g.reserve_speech(1000)
    with pytest.raises(BudgetExhausted):
        g.reserve_speech(1000)  # 30 s would pass 25
    assert ledger.used(DAY, BudgetCategory.SPEECH_SECONDS) == 20
    assert ledger.used(DAY, BudgetCategory.AGENT_TOKENS) == 0


def test_a_ledger_that_cannot_be_reached_fails_closed(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level("DEBUG", logger="voice_agent_api")
    g = guard(FailingLedger())
    with pytest.raises(BudgetUnavailable):
        g.reserve_agent_turn()
    with pytest.raises(BudgetUnavailable):
        g.reserve_speech(100)
    logged = " ".join(r.getMessage() for r in caplog.records)
    assert "SECRET-DETAIL" not in logged and "RuntimeError" in logged


def test_settling_or_refunding_never_fails_a_request_that_already_did_its_work() -> None:
    reservation = guard(InMemoryBudgetLedger()).reserve_agent_turn()
    broken = guard(FailingLedger())
    broken.settle(reservation, 10)  # no exception
    broken.refund(reservation)


def test_concurrent_reservations_cannot_overspend() -> None:
    ledger = InMemoryBudgetLedger()
    g = guard(ledger, tokens=4000, reserve=400)
    granted: list[bool] = []
    lock = threading.Lock()

    def worker() -> None:
        try:
            g.reserve_agent_turn()
            ok = True
        except BudgetExhausted:
            ok = False
        with lock:
            granted.append(ok)

    threads = [threading.Thread(target=worker) for _ in range(40)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(granted) == 10
    assert ledger.used(DAY, BudgetCategory.AGENT_TOKENS) == 4000


def test_the_defaults_are_half_of_the_provider_free_daily_limits() -> None:
    settings = Settings(_env_file=None)
    assert settings.agent_daily_token_budget == 100_000  # half of 200,000 tokens a day
    assert settings.speech_daily_audio_seconds == 14_400  # half of 28,800 audio seconds a day
    assert settings.speech_min_billed_seconds == 10
    assert settings.agent_turn_token_reserve == 4000
    g = BudgetGuard.from_settings(InMemoryBudgetLedger(), lambda: NOON, settings)
    assert g.speech_charge(15 * 17_000) == 85  # a clip of 15 s at the highest browser bitrate
