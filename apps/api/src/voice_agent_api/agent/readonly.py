"""The only appointment book the agent ever receives.

It satisfies the `AppointmentBook` port for the two reads the tools need and refuses everything
else at runtime, so even a bug in this package cannot reach the write path.
"""

from collections.abc import Sequence
from datetime import date, datetime
from uuid import UUID

from voice_agent_api.agent.errors import AgentWriteForbidden
from voice_agent_api.domain.models import Appointment, Booking, CatalogSnapshot, Proposal
from voice_agent_api.domain.ports import AppointmentBook, Decide


class ReadOnlyAppointmentBook:
    def __init__(self, inner: AppointmentBook) -> None:
        self._inner = inner

    def bookings_overlapping(self, start: datetime, end: datetime) -> Sequence[Booking]:
        return self._inner.bookings_overlapping(start, end)

    def day_view(
        self, service_id: str, when: date | datetime
    ) -> tuple[CatalogSnapshot, Sequence[Booking]]:
        return self._inner.day_view(service_id, when)

    def confirm(self, proposal: Proposal, decide: Decide) -> tuple[Appointment, bool]:
        raise AgentWriteForbidden

    def get(self, appointment_id: UUID) -> Appointment | None:
        raise AgentWriteForbidden
