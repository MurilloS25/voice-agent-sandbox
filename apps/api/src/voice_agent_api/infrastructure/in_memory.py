import threading
from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime
from uuid import UUID, uuid4

from voice_agent_api.domain.availability import local_day_bounds, local_day_of
from voice_agent_api.domain.models import (
    Appointment,
    Booking,
    Business,
    CatalogSnapshot,
    Proposal,
    Service,
    WeeklyHours,
)
from voice_agent_api.domain.ports import BusinessCatalog, Decide


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

    def snapshot(self, service_id: str | None = None) -> CatalogSnapshot:
        service = self.service_by_id(service_id) if service_id is not None else None
        return CatalogSnapshot(self._business, self._hours, service)


def _utc_now() -> datetime:
    return datetime.now(UTC)


class InMemoryAppointmentBook:
    """Same port semantics as the Postgres adapter: one lock makes confirmation atomic."""

    def __init__(
        self,
        catalog: BusinessCatalog,
        bookings: Sequence[Booking] = (),
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        self._catalog = catalog
        self._clock = clock
        self._lock = threading.Lock()
        self._bookings: list[Booking] = list(bookings)
        self._appointments: dict[UUID, Appointment] = {}
        self._by_proposal: dict[UUID, UUID] = {}

    def bookings_overlapping(self, start: datetime, end: datetime) -> Sequence[Booking]:
        with self._lock:
            return self._overlapping(start, end)

    def day_view(
        self, service_id: str, when: date | datetime
    ) -> tuple[CatalogSnapshot, Sequence[Booking]]:
        with self._lock:
            snapshot = self._catalog.snapshot(service_id)
            day_start, day_end = local_day_bounds(
                snapshot.business, local_day_of(snapshot.business, when)
            )
            return snapshot, self._overlapping(day_start, day_end)

    def _overlapping(self, start: datetime, end: datetime) -> tuple[Booking, ...]:
        return tuple(b for b in self._bookings if b.start < end and b.end > start)

    def confirm(self, proposal: Proposal, decide: Decide) -> tuple[Appointment, bool]:
        with self._lock:
            existing_id = self._by_proposal.get(proposal.id)
            if existing_id is not None:
                return self._appointments[existing_id], False

            snapshot = self._catalog.snapshot(proposal.service_id)
            day_start, day_end = local_day_bounds(
                snapshot.business, local_day_of(snapshot.business, proposal.start)
            )
            new = decide(snapshot, self._overlapping(day_start, day_end))

            now = self._clock()
            appointment = Appointment(
                id=uuid4(),
                business_id=new.business_id,
                service_id=new.service_id,
                bench=new.bench,
                start=new.start,
                end=new.end,
                status="confirmed",
                customer_alias=new.customer_alias,
                source=new.source,
                proposal_id=new.proposal_id,
                created_at=now,
                updated_at=now,
                service_name=new.service_name,
                price=new.price,
                timezone=new.timezone,
            )
            self._appointments[appointment.id] = appointment
            self._by_proposal[proposal.id] = appointment.id
            self._bookings.append(Booking(new.service_id, new.start, new.end, new.bench))
            return appointment, True

    def get(self, appointment_id: UUID) -> Appointment | None:
        with self._lock:
            return self._appointments.get(appointment_id)
