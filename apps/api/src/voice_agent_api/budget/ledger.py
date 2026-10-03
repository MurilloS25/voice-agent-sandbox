"""The ledger port and its in-memory implementation (local development and tests).

The PostgreSQL implementation lives with the other adapters (`infrastructure/postgres.py`); both
keep the same rules:

- `reserve` adds `amount` to today's use only if the result stays within `limit`, in one atomic
  step, and says whether it did;
- `adjust` moves the use by a signed amount (settling real usage, or giving back a reservation)
  and never takes it below zero. It may take it past the limit: that spend already happened.
"""

import threading
from datetime import date
from enum import StrEnum
from typing import Protocol


class BudgetCategory(StrEnum):
    AGENT_TOKENS = "agent_tokens"
    SPEECH_SECONDS = "speech_seconds"


class BudgetLedger(Protocol):
    def reserve(self, day: date, category: BudgetCategory, amount: int, limit: int) -> bool:
        """True when `amount` was reserved. Raises `BudgetUnavailable` if it cannot be checked."""
        ...

    def adjust(self, day: date, category: BudgetCategory, delta: int) -> None:
        """Move the day's use by `delta`. Raises `BudgetUnavailable` if it cannot be recorded."""
        ...


class InMemoryBudgetLedger:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._used: dict[tuple[date, BudgetCategory], int] = {}

    def reserve(self, day: date, category: BudgetCategory, amount: int, limit: int) -> bool:
        with self._lock:
            used = self._used.get((day, category), 0)
            if used + amount > limit:
                return False
            self._used[(day, category)] = used + amount
            return True

    def adjust(self, day: date, category: BudgetCategory, delta: int) -> None:
        with self._lock:
            used = self._used.get((day, category), 0)
            self._used[(day, category)] = max(0, used + delta)

    def used(self, day: date, category: BudgetCategory) -> int:
        with self._lock:
            return self._used.get((day, category), 0)
