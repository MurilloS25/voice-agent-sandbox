"""Typed budget errors. Messages are fixed strings; they never carry an amount or a limit."""

from voice_agent_api.domain.errors import DomainError


class BudgetError(DomainError):
    """Base of the budget refusals: the provider is not called."""


class BudgetExhausted(BudgetError):
    """Today's allowance is used up. The demo is paused until the next UTC day."""

    def __init__(self) -> None:
        super().__init__("The demo has reached its daily limit. Please try again tomorrow.")


class BudgetUnavailable(BudgetError):
    """The budget could not be checked, so nothing costly is allowed (fail closed)."""

    def __init__(self) -> None:
        super().__init__("The demo is temporarily unavailable. Please try again shortly.")
