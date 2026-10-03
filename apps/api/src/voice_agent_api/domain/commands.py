"""Appointment commands: propose (no write) and confirm (the only write).

Everything stored by `confirm_appointment` is recomputed from a freshly read catalog. The
proposal contributes only its id, service id, start and expiry; its fingerprint is compared
against a freshly computed one and never supplies a value.
"""

from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta
from uuid import UUID

from voice_agent_api.domain.aliases import alias_for
from voice_agent_api.domain.availability import check_slot
from voice_agent_api.domain.errors import (
    ProposalDiscarded,
    ProposalExpired,
    ProposalStale,
    ServiceNotFound,
)
from voice_agent_api.domain.fingerprint import catalog_fingerprint, fingerprints_match
from voice_agent_api.domain.models import (
    Appointment,
    Booking,
    CatalogSnapshot,
    NewAppointment,
    Proposal,
    ProposalReview,
)
from voice_agent_api.domain.ports import AppointmentBook

PROPOSAL_TTL = timedelta(minutes=10)
SOURCE_WEB_DEMO = "web_demo"


def propose_appointment(
    appointments: AppointmentBook,
    service_id: str,
    start: datetime,
    now: datetime,
    new_id: Callable[[], UUID],
    ttl: timedelta = PROPOSAL_TTL,
) -> ProposalReview:
    """Validate a slot and describe what confirming it would book. Writes nothing."""
    start_utc = start.astimezone(UTC)
    snapshot, bookings = appointments.day_view(service_id, start_utc)
    service = snapshot.service
    if service is None:
        raise ServiceNotFound(service_id)

    check_slot(snapshot.business, snapshot.hours, service, start_utc, bookings, now)

    proposal = Proposal(
        id=new_id(),
        service_id=service.id,
        start=start_utc,
        # Whole seconds: the token carries expiry as an integer.
        expires_at=(now + ttl).astimezone(UTC).replace(microsecond=0),
        fingerprint=catalog_fingerprint(snapshot.business, service),
    )
    return ProposalReview(
        proposal=proposal,
        service=service,
        timezone=snapshot.business.timezone.key,
        end=start_utc + service.duration,
        customer_alias=alias_for(proposal.id),
    )


def confirm_appointment(
    appointments: AppointmentBook,
    proposal: Proposal,
    now: datetime,
    source: str = SOURCE_WEB_DEMO,
    is_discarded: Callable[[UUID], bool] | None = None,
) -> tuple[Appointment, bool]:
    """Create the appointment for a verified proposal, or return the one it already created.

    Returns (appointment, created). Runs `decide` inside the adapter's locked transaction.
    `is_discarded` tells whether the visitor withdrew this proposal; it is asked only when a new
    appointment would be created, so replaying a confirmation that already booked is unaffected.
    """

    def decide(snapshot: CatalogSnapshot, bookings: Sequence[Booking]) -> NewAppointment:
        if is_discarded is not None and is_discarded(proposal.id):
            raise ProposalDiscarded
        if now >= proposal.expires_at:
            raise ProposalExpired
        service = snapshot.service
        if service is None or not fingerprints_match(
            proposal.fingerprint, catalog_fingerprint(snapshot.business, service)
        ):
            raise ProposalStale
        bench = check_slot(
            snapshot.business, snapshot.hours, service, proposal.start, bookings, now
        )
        return NewAppointment(
            business_id=snapshot.business.id,
            service_id=service.id,
            bench=bench,
            start=proposal.start,
            end=proposal.start + service.duration,
            customer_alias=alias_for(proposal.id),
            source=source,
            proposal_id=proposal.id,
            service_name=service.name,
            price=service.price,
            timezone=snapshot.business.timezone.key,
        )

    return appointments.confirm(proposal, decide)
