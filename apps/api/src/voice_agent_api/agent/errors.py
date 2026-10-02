"""Typed agent errors. Messages are fixed strings that never carry submitted values."""

from voice_agent_api.domain.errors import DomainError


class AgentWriteForbidden(RuntimeError):
    """The agent's read-only appointment book was asked to write. A bug guard, never expected."""

    def __init__(self) -> None:
        super().__init__("The agent may not write appointments.")


class AgentUnavailable(DomainError):
    def __init__(self) -> None:
        super().__init__("The assistant is not available. You can still book with the form.")


class ConversationNotFound(DomainError):
    def __init__(self) -> None:
        super().__init__("That conversation is not available. Start a new one.")


class ConversationExpired(DomainError):
    def __init__(self) -> None:
        super().__init__("That conversation expired. Start a new one.")


class IdempotencyKeyReused(DomainError):
    def __init__(self) -> None:
        super().__init__("That turn id was already used for a different message.")


class TurnInProgress(DomainError):
    retry_after_s = 2

    def __init__(self) -> None:
        super().__init__("That turn is still being processed. Try again in a moment.")


class ConversationBusy(DomainError):
    retry_after_s = 2

    def __init__(self) -> None:
        super().__init__("Another message in this conversation is still being processed.")


class TurnOutOfOrder(DomainError):
    def __init__(self) -> None:
        super().__init__("That message does not follow the conversation. Start a new one.")


class ConversationLimitReached(DomainError):
    def __init__(self) -> None:
        super().__init__("This conversation reached its length limit. Start a new one.")


class AgentBusy(DomainError):
    retry_after_s = 5

    def __init__(self) -> None:
        super().__init__("The assistant is busy. Try again shortly.")


class ProviderError(Exception):
    """Raised by a provider adapter. `code` is one of the `provider_error` event codes."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code
