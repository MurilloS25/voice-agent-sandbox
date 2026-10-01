from dataclasses import dataclass
from datetime import date, datetime

from voice_agent_api.domain.availability import available_slots
from voice_agent_api.domain.errors import ServiceNotFound
from voice_agent_api.domain.models import Slot
from voice_agent_api.domain.ports import AppointmentBook


@dataclass(frozen=True)
class Availability:
    timezone: str
    slots: list[Slot]


def query_availability(
    appointments: AppointmentBook,
    service_id: str,
    local_date: date,
    now: datetime,
) -> Availability:
    """Resolve the service, load bookings for the local day, and compute open slots."""
    snapshot, bookings = appointments.day_view(service_id, local_date)
    if snapshot.service is None:
        raise ServiceNotFound(service_id)
    slots = available_slots(
        snapshot.business, snapshot.hours, snapshot.service, local_date, bookings, now
    )
    return Availability(timezone=snapshot.business.timezone.key, slots=slots)


def get_availability(
    appointments: AppointmentBook,
    service_id: str,
    local_date: date,
    now: datetime,
) -> list[Slot]:
    return query_availability(appointments, service_id, local_date, now).slots
