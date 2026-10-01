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


class SlotNotOffered(DomainError):
    """The start is not an offered slot at all (grid, hours, lead time, DST)."""

    def __init__(self) -> None:
        super().__init__("That start time is not offered for this service.")


class SlotUnavailable(DomainError):
    """The start is normally offered, but every bench is taken for the whole job."""

    def __init__(self) -> None:
        super().__init__("That time was just taken. Choose another time.")


class ProposalInvalid(DomainError):
    def __init__(self) -> None:
        super().__init__("The booking review could not be verified. Review it again.")


class ProposalExpired(DomainError):
    def __init__(self) -> None:
        super().__init__("The booking review expired. Review it again.")


class ProposalStale(DomainError):
    """The reviewed catalog values no longer match the current catalog. Nothing was written."""

    def __init__(self) -> None:
        super().__init__(
            "The service details changed since you reviewed this booking. Review it again."
        )


class AppointmentNotFound(DomainError):
    def __init__(self) -> None:
        super().__init__("No appointment matches that id.")


class StorageUnavailable(DomainError):
    """Storage could not be reached or timed out. The message is fixed and never carries detail."""

    def __init__(self) -> None:
        super().__init__("The schedule service is temporarily unavailable.")
