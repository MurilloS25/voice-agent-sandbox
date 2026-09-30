from datetime import date


class DomainError(Exception):
    """Base class for expected, business-level failures."""


class ServiceNotFound(DomainError):
    def __init__(self, service_id: str) -> None:
        # The id is kept as an attribute for logs and callers; it is not put in the message.
        super().__init__("No service matches that id.")
        self.service_id = service_id


class DateOutsideBookingWindow(DomainError):
    def __init__(self, requested: date, first: date, last: date) -> None:
        super().__init__(
            f"{requested.isoformat()} is outside the booking window "
            f"({first.isoformat()} to {last.isoformat()})."
        )
        self.requested = requested
        self.first = first
        self.last = last
