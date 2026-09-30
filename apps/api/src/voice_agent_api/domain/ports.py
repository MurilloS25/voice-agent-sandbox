from collections.abc import Sequence
from datetime import datetime
from typing import Protocol

from voice_agent_api.domain.models import Booking, Business, Service, WeeklyHours


class BusinessCatalog(Protocol):
    def business(self) -> Business: ...

    def hours(self) -> WeeklyHours: ...

    def services(self) -> Sequence[Service]: ...

    def service_by_id(self, service_id: str) -> Service | None: ...


class AppointmentBook(Protocol):
    def bookings_overlapping(self, start: datetime, end: datetime) -> Sequence[Booking]: ...
