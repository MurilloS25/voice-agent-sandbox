from collections.abc import Callable, Sequence
from datetime import date, datetime
from typing import Protocol
from uuid import UUID

from voice_agent_api.domain.models import (
    Appointment,
    Booking,
    Business,
    CatalogSnapshot,
    NewAppointment,
    Proposal,
    Service,
    WeeklyHours,
)

# Called by an adapter inside its locked transaction with a freshly read snapshot and the
# confirmed bookings for the local day. It raises a DomainError or returns the values to store.
Decide = Callable[[CatalogSnapshot, Sequence[Booking]], NewAppointment]


class BusinessCatalog(Protocol):
    def business(self) -> Business: ...

    def hours(self) -> WeeklyHours: ...

    def services(self) -> Sequence[Service]: ...

    def service_by_id(self, service_id: str) -> Service | None: ...

    def snapshot(self, service_id: str | None = None) -> CatalogSnapshot:
        """Read the business, hours and (optionally) one service together, as of now."""
        ...


class AppointmentBook(Protocol):
    def bookings_overlapping(self, start: datetime, end: datetime) -> Sequence[Booking]: ...

    def day_view(
        self, service_id: str, when: date | datetime
    ) -> tuple[CatalogSnapshot, Sequence[Booking]]:
        """A fresh catalog snapshot plus the confirmed bookings for one business-local day.

        `when` is either a local calendar date, or an instant (the day containing it in the
        business timezone). Both parts come from one read (one transaction in PostgreSQL),
        so availability and review see a consistent view and pay for one round of timeouts.
        """
        ...

    def confirm(self, proposal: Proposal, decide: Decide) -> tuple[Appointment, bool]:
        """Atomically create the appointment, or return the one this proposal already created.

        Returns (appointment, created). A replay returns (original, False) without calling
        `decide`.
        """
        ...

    def get(self, appointment_id: UUID) -> Appointment | None: ...
