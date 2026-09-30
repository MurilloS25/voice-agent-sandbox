from datetime import UTC, date, datetime, timedelta

from voice_agent_api.domain.availability import available_slots
from voice_agent_api.domain.errors import ServiceNotFound
from voice_agent_api.domain.models import Slot
from voice_agent_api.domain.ports import AppointmentBook, BusinessCatalog


def get_availability(
    catalog: BusinessCatalog,
    appointments: AppointmentBook,
    service_id: str,
    local_date: date,
    now: datetime,
) -> list[Slot]:
    """Resolve the service, load bookings for the local day, and compute open slots."""
    service = catalog.service_by_id(service_id)
    if service is None:
        raise ServiceNotFound(service_id)

    business = catalog.business()
    day_start = datetime.combine(local_date, datetime.min.time()).replace(tzinfo=business.timezone)
    day_end = datetime.combine(local_date + timedelta(days=1), datetime.min.time()).replace(
        tzinfo=business.timezone
    )
    bookings = appointments.bookings_overlapping(day_start.astimezone(UTC), day_end.astimezone(UTC))
    return available_slots(business, catalog.hours(), service, local_date, bookings, now)
