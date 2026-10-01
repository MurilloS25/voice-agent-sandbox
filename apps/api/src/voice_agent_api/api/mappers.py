"""Domain-to-wire mappers shared by the booking routes and the agent."""

from voice_agent_api.api.schemas import (
    AppointmentProposalResponse,
    MoneyResponse,
    ServiceResponse,
)
from voice_agent_api.domain.models import ProposalReview, Service


def service_response(service: Service) -> ServiceResponse:
    return ServiceResponse(
        id=service.id,
        name=service.name,
        description=service.description,
        duration_minutes=int(service.duration.total_seconds() // 60),
        price=MoneyResponse(
            amount_minor=service.price.amount_minor, currency=service.price.currency
        ),
    )


def proposal_response(review: ProposalReview, token: str) -> AppointmentProposalResponse:
    return AppointmentProposalResponse(
        proposal_token=token,
        expires_at=review.proposal.expires_at,
        service=service_response(review.service),
        start=review.proposal.start,
        end=review.end,
        timezone=review.timezone,
        customer_alias=review.customer_alias,
    )
