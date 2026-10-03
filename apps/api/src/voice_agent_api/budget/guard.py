"""Reserve before the provider call, settle after it.

What happens when a reserved call does not finish (plan 0007, decision D5):

- The request is refused before the provider is contacted (rate limit, validation, a busy slot,
  shutdown): the reservation is **given back in full**.
- The provider was contacted and the call failed, timed out or was abandoned: the provider may
  have counted it, and the server cannot know, so the reservation **stays** (the budget errs on
  the side of spending too little, never too much).
- The provider answered with usage: the reservation is **settled** to the real number.

Every settle or refund is best effort: it can never fail a request that already did its work.
A failure to *reserve* does fail the request, before any cost.
"""

import logging
import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime

from voice_agent_api.budget.errors import BudgetError, BudgetExhausted, BudgetUnavailable
from voice_agent_api.budget.ledger import BudgetCategory, BudgetLedger
from voice_agent_api.config import Settings

logger = logging.getLogger("voice_agent_api")


@dataclass(frozen=True)
class Reservation:
    day: date
    category: BudgetCategory
    amount: int


class BudgetGuard:
    def __init__(
        self,
        ledger: BudgetLedger,
        clock: Callable[[], datetime],
        *,
        agent_daily_tokens: int,
        agent_turn_reserve: int,
        speech_daily_seconds: int,
        speech_min_billed_seconds: int,
        speech_min_bytes_per_second: int,
    ) -> None:
        self._ledger = ledger
        self._clock = clock
        self._agent_limit = agent_daily_tokens
        self._agent_reserve = agent_turn_reserve
        self._speech_limit = speech_daily_seconds
        self._speech_min_billed = speech_min_billed_seconds
        self._speech_min_bps = speech_min_bytes_per_second

    @classmethod
    def from_settings(
        cls, ledger: BudgetLedger, clock: Callable[[], datetime], settings: Settings
    ) -> "BudgetGuard":
        return cls(
            ledger,
            clock,
            agent_daily_tokens=settings.agent_daily_token_budget,
            agent_turn_reserve=settings.agent_turn_token_reserve,
            speech_daily_seconds=settings.speech_daily_audio_seconds,
            speech_min_billed_seconds=settings.speech_min_billed_seconds,
            speech_min_bytes_per_second=settings.speech_min_bytes_per_second,
        )

    def _today(self) -> date:
        return self._clock().astimezone(UTC).date()

    def _reserve(self, category: BudgetCategory, amount: int, limit: int) -> Reservation:
        day = self._today()
        try:
            granted = self._ledger.reserve(day, category, amount, limit)
        except BudgetError:
            raise
        except Exception as exc:  # any ledger failure: the budget cannot be checked
            logger.warning("budget_error stage=reserve error=%s", type(exc).__name__)
            raise BudgetUnavailable from None
        if not granted:
            logger.info("budget_refused category=%s", category.value)
            raise BudgetExhausted
        return Reservation(day, category, amount)

    def reserve_agent_turn(self) -> Reservation:
        return self._reserve(BudgetCategory.AGENT_TOKENS, self._agent_reserve, self._agent_limit)

    def speech_charge(self, size_bytes: int) -> int:
        """Seconds charged for a clip: the larger of the provider's minimum billed time and its
        worst-case length (its size at the lowest bitrate a browser encodes). The server cannot
        measure the real length, so the charge is an upper bound."""
        worst_case = math.ceil(max(0, size_bytes) / self._speech_min_bps)
        return max(self._speech_min_billed, worst_case)

    def reserve_speech(self, size_bytes: int) -> Reservation:
        return self._reserve(
            BudgetCategory.SPEECH_SECONDS, self.speech_charge(size_bytes), self._speech_limit
        )

    def settle(self, reservation: Reservation, actual: int) -> None:
        """Replace the reservation by the real amount (it can be larger or smaller)."""
        self._adjust(reservation, actual - reservation.amount)

    def refund(self, reservation: Reservation) -> None:
        """Give the reservation back: the provider was never contacted."""
        self._adjust(reservation, -reservation.amount)

    def _adjust(self, reservation: Reservation, delta: int) -> None:
        if delta == 0:
            return
        try:
            self._ledger.adjust(reservation.day, reservation.category, delta)
        except Exception as exc:  # best effort: the request already did its work
            logger.warning("budget_error stage=adjust error=%s", type(exc).__name__)
