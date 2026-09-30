from collections.abc import Sequence
from datetime import datetime

from voice_agent_api.domain.models import Booking, Business, Service, WeeklyHours


class InMemoryCatalog:
    def __init__(self, business: Business, hours: WeeklyHours, services: Sequence[Service]) -> None:
        self._business = business
        self._hours = hours
        self._services = tuple(services)
        self._by_id = {s.id: s for s in self._services}

    def business(self) -> Business:
        return self._business

    def hours(self) -> WeeklyHours:
        return self._hours

    def services(self) -> Sequence[Service]:
        return self._services

    def service_by_id(self, service_id: str) -> Service | None:
        return self._by_id.get(service_id)


class InMemoryAppointmentBook:
    def __init__(self, bookings: Sequence[Booking] = ()) -> None:
        self._bookings = tuple(bookings)

    def bookings_overlapping(self, start: datetime, end: datetime) -> Sequence[Booking]:
        return tuple(b for b in self._bookings if b.start < end and b.end > start)
