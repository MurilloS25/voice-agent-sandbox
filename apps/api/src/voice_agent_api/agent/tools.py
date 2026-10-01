"""The allow-listed tools. Nothing else is executable.

Every argument is untrusted model output and is validated here. Tools read the catalog and
availability, and `prepare_booking_review` calls `propose_appointment`, which writes nothing.
There is no confirm, cancel or reschedule tool.

Results sent back to the model are built from domain data only: they never echo free user text
and never contain the proposal token or any proposal or appointment id. The token goes only into
the typed `PreparedReview.wire`, which the orchestrator puts in the response's `booking_review`.
"""

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Annotated, Any, Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError

from voice_agent_api.agent.contracts import ToolInput
from voice_agent_api.agent.formatting import WEEKDAYS, local_parts, price_display
from voice_agent_api.agent.limits import AgentLimits
from voice_agent_api.agent.state import OfferedSlot, PendingReview, PreparedReview
from voice_agent_api.api.mappers import proposal_response
from voice_agent_api.domain.availability import booking_window
from voice_agent_api.domain.commands import propose_appointment
from voice_agent_api.domain.errors import (
    DateOutsideBookingWindow,
    ServiceNotFound,
    SlotNotOffered,
    SlotUnavailable,
    StorageUnavailable,
)
from voice_agent_api.domain.models import Proposal, Slot
from voice_agent_api.domain.ports import AppointmentBook, BusinessCatalog
from voice_agent_api.domain.queries import query_availability

_DATE_ONLY = re.compile(r"\d{4}-\d{2}-\d{2}")
_CLOCK_TIME = re.compile(r"([01]\d|2[0-3]):[0-5]\d")


def _date_only(value: object) -> object:
    if not isinstance(value, str) or not _DATE_ONLY.fullmatch(value):
        raise ValueError("Expected YYYY-MM-DD.")
    return value


def _clock_time(value: object) -> object:
    if not isinstance(value, str) or not _CLOCK_TIME.fullmatch(value):
        raise ValueError("Expected HH:MM.")
    return value


DateOnly = Annotated[date, BeforeValidator(_date_only)]
ClockTime = Annotated[time, BeforeValidator(_clock_time)]


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class NoArgs(_Args):
    """No arguments."""


class FindAvailableSlotsArgs(_Args):
    service_id: str = Field(
        pattern=r"^[a-z0-9-]{1,64}$", description="A service id from the service list."
    )
    date: DateOnly = Field(description="First local date to search, YYYY-MM-DD.")
    days: int = Field(default=1, ge=1, le=3, description="How many consecutive days, 1 to 3.")
    earliest_local_time: ClockTime | None = Field(
        default=None, description="Only start times at or after this local HH:MM."
    )
    latest_local_time: ClockTime | None = Field(
        default=None, description="Only start times at or before this local HH:MM."
    )


class PrepareBookingReviewArgs(_Args):
    slot_id: str = Field(
        pattern=r"^S([1-9]|10)$",
        description="A slot_id from the most recent find_available_slots result.",
    )


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    args_model: type[_Args]

    def openai_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.args_model.model_json_schema(),
            },
        }


TOOLS: dict[str, ToolSpec] = {
    spec.name: spec
    for spec in (
        ToolSpec(
            "get_business_info",
            "The shop's name, address, phone, opening hours and booking window.",
            NoArgs,
        ),
        ToolSpec(
            "list_services",
            "All services with duration and exact price. Call it for every question about "
            "services, prices, costs or comparisons.",
            NoArgs,
        ),
        ToolSpec(
            "find_available_slots",
            "Open appointment times for a service from a date, optionally for up to 3 days and "
            "within a local time range. Call it for every question about availability, dates, "
            "mornings or afternoons, including a refinement of an earlier search (afternoon: "
            "earliest_local_time 12:00). Returns slot ids to use with prepare_booking_review.",
            FindAvailableSlotsArgs,
        ),
        ToolSpec(
            "prepare_booking_review",
            "Prepare a booking review for an offered slot. Books nothing: the visitor confirms "
            "with a button.",
            PrepareBookingReviewArgs,
        ),
    )
}


def tool_specs() -> list[dict[str, Any]]:
    return [spec.openai_schema() for spec in TOOLS.values()]


def parse_tool_args(name: str, raw: object) -> _Args:
    """Validate model-produced arguments. Raises `ValidationError`; callers never echo its input."""
    return TOOLS[name].args_model.model_validate(raw)


def issue_codes(name: str, error: ValidationError) -> list[str]:
    """`field:type` pairs, with only schema field names, so model-chosen keys are never echoed."""
    fields = set(TOOLS[name].args_model.model_fields)
    issues: set[str] = set()
    for err in error.errors():
        loc = str(err["loc"][0]) if err["loc"] else ""
        issues.add(f"{loc if loc in fields else '?'}:{err['type']}")
    return sorted(issues)


def tool_input_for_event(args: _Args) -> ToolInput:
    data = args.model_dump(exclude_none=True)
    if isinstance(data.get("date"), date):
        data["date"] = data["date"].isoformat()
    for key in ("earliest_local_time", "latest_local_time"):
        if isinstance(data.get(key), time):
            data[key] = data[key].strftime("%H:%M")
    return ToolInput.model_validate(data)


@dataclass(frozen=True)
class ToolOutcome:
    status: Literal["ok", "rejected", "error"]
    code: str | None
    summary: str
    content: str  # JSON text sent back to the model
    offered: tuple[OfferedSlot, ...] | None = None
    review: PreparedReview | None = None


def _json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"))


def _rejected(code: str, summary: str, **extra: Any) -> ToolOutcome:
    return ToolOutcome(
        "rejected", code, summary, _json({"status": "rejected", "code": code, **extra})
    )


@dataclass(frozen=True)
class PromptFacts:
    """What the system prompt is built from. Read through a bounded call."""

    business_name: str
    timezone: ZoneInfo
    first_date: date
    last_date: date
    today_local: date
    services: tuple[tuple[str, str, int, str], ...]  # id, name, minutes, price display
    hours_text: str


def read_prompt_facts(catalog: BusinessCatalog, now: datetime) -> PromptFacts:
    snapshot = catalog.snapshot()
    business = snapshot.business
    window = booking_window(business, now)
    services = tuple(
        (s.id, s.name, int(s.duration.total_seconds() // 60), price_display(s.price))
        for s in catalog.services()
    )
    return PromptFacts(
        business_name=business.name,
        timezone=business.timezone,
        first_date=window.first_date,
        last_date=window.last_date,
        today_local=now.astimezone(business.timezone).date(),
        services=services,
        hours_text=_hours_text(snapshot.hours.intervals),
    )


def _hours_text(intervals: tuple[Any, ...]) -> str:
    by_day: dict[int, list[str]] = {}
    for interval in sorted(intervals, key=lambda i: (i.weekday, i.start)):
        by_day.setdefault(interval.weekday, []).append(
            f"{interval.start.strftime('%H:%M')}-{interval.end.strftime('%H:%M')}"
        )
    return "; ".join(f"{WEEKDAYS[d]} {', '.join(spans)}" for d, spans in sorted(by_day.items()))


class ToolExecutor:
    """Runs validated tool calls against the domain. Returns values only: it never touches a
    conversation, so a call abandoned after a timeout cannot change anything."""

    def __init__(
        self,
        catalog: BusinessCatalog,
        appointments: AppointmentBook,
        new_id: Callable[[], UUID],
        encode: Callable[[Proposal], str],
        limits: AgentLimits,
    ) -> None:
        self._catalog = catalog
        self._appointments = appointments
        self._new_id = new_id
        self._encode = encode
        self._limits = limits

    def run(
        self, name: str, args: _Args, offered: tuple[OfferedSlot, ...], now: datetime
    ) -> ToolOutcome:
        try:
            if name == "get_business_info":
                return self._business_info(now)
            if name == "list_services":
                return self._list_services()
            if isinstance(args, FindAvailableSlotsArgs):
                return self._find_slots(args, now)
            if isinstance(args, PrepareBookingReviewArgs):
                return self._prepare_review(args, offered, now)
        except ServiceNotFound:
            return _rejected("service_not_found", "No service matches that id.")
        except DateOutsideBookingWindow as exc:
            return _rejected(
                "date_out_of_range",
                "That date is outside the booking window.",
                first_date=exc.first.isoformat(),
                last_date=exc.last.isoformat(),
            )
        except SlotNotOffered:
            return _rejected("slot_not_offered", "That time is not offered.")
        except SlotUnavailable:
            return _rejected("slot_unavailable", "That time was just taken.")
        except StorageUnavailable:
            return ToolOutcome(
                "error",
                "storage_unavailable",
                "The schedule service is unavailable.",
                _json({"status": "error", "code": "storage_unavailable"}),
            )
        return _rejected("tool_not_allowed", "Unknown tool.")

    def _business_info(self, now: datetime) -> ToolOutcome:
        snapshot = self._catalog.snapshot()
        business = snapshot.business
        window = booking_window(business, now)
        hours = [
            {
                "day": WEEKDAYS[i.weekday],
                "open": i.start.strftime("%H:%M"),
                "close": i.end.strftime("%H:%M"),
            }
            for i in snapshot.hours.intervals
        ]
        content = _json(
            {
                "status": "ok",
                "name": business.name,
                "tagline": business.tagline,
                "address": business.address,
                "phone": business.phone,
                "timezone": business.timezone.key,
                "currency": business.currency,
                "hours": hours,
                "booking_window": {
                    "first_date": window.first_date.isoformat(),
                    "last_date": window.last_date.isoformat(),
                },
                "note": "Fictional demo business.",
            }
        )
        return ToolOutcome("ok", None, "Read the business details and opening hours.", content)

    def _list_services(self) -> ToolOutcome:
        services = [
            {
                "id": s.id,
                "name": s.name,
                "description": s.description,
                "minutes": int(s.duration.total_seconds() // 60),
                "price": price_display(s.price),
            }
            for s in self._catalog.services()
        ]
        return ToolOutcome(
            "ok",
            None,
            f"Listed {len(services)} services.",
            _json({"status": "ok", "services": services}),
        )

    def _find_slots(self, args: FindAvailableSlotsArgs, now: datetime) -> ToolOutcome:
        found: list[Slot] = []
        tz: ZoneInfo | None = None
        for offset in range(args.days):
            day = args.date + timedelta(days=offset)
            try:
                availability = query_availability(self._appointments, args.service_id, day, now)
            except DateOutsideBookingWindow:
                if offset == 0:
                    raise
                break  # a later day beyond the window just ends the search
            tz = ZoneInfo(availability.timezone)
            for slot in availability.slots:
                local_time = slot.start.astimezone(tz).time()
                if args.earliest_local_time and local_time < args.earliest_local_time:
                    continue
                if args.latest_local_time and local_time > args.latest_local_time:
                    continue
                found.append(slot)
        assert tz is not None  # the first day either succeeded or raised
        service = self._catalog.service_by_id(args.service_id)
        service_name = service.name if service is not None else args.service_id
        shown = found[: self._limits.max_slots_offered]
        offered: list[OfferedSlot] = []
        for index, slot in enumerate(shown, start=1):
            local_date, weekday, local_start = local_parts(slot.start, tz)
            _, _, local_end = local_parts(slot.end, tz)
            offered.append(
                OfferedSlot(
                    slot_id=f"S{index}",
                    service_id=args.service_id,
                    service_name=service_name,
                    start=slot.start.astimezone(UTC),
                    local_date=local_date,
                    weekday=weekday,
                    local_start=local_start,
                    local_end=local_end,
                )
            )
        content = _json(
            {
                "status": "ok",
                "service": service_name,
                "timezone": tz.key,
                "slots": [
                    {
                        "slot_id": s.slot_id,
                        "date": s.local_date,
                        "weekday": s.weekday,
                        "start": s.local_start,
                        "end": s.local_end,
                    }
                    for s in offered
                ],
                "more_available": len(found) > len(shown),
                "note": (
                    "No open times in that range."
                    if not offered
                    else "Use a slot_id with prepare_booking_review."
                ),
            }
        )
        return ToolOutcome(
            "ok",
            None,
            f"Found {len(offered)} open time(s) for {service_name}.",
            content,
            offered=tuple(offered),
        )

    def _prepare_review(
        self, args: PrepareBookingReviewArgs, offered: tuple[OfferedSlot, ...], now: datetime
    ) -> ToolOutcome:
        slot = next((s for s in offered if s.slot_id == args.slot_id), None)
        if slot is None:
            return _rejected(
                "slot_not_offered", "That slot id was not offered in this conversation."
            )
        review = propose_appointment(
            self._appointments, slot.service_id, slot.start, now, self._new_id
        )
        tz = ZoneInfo(review.timezone)
        local_date, _, local_start = local_parts(review.proposal.start, tz)
        _, _, local_end = local_parts(review.end, tz)
        shown_price = price_display(review.service.price)
        pending = PendingReview(
            service_name=review.service.name,
            local_date=local_date,
            local_start=local_start,
            local_end=local_end,
            timezone=review.timezone,
            price_display=shown_price,
            expires_at=review.proposal.expires_at,
        )
        prepared = PreparedReview(
            wire=proposal_response(review, self._encode(review.proposal)), pending=pending
        )
        content = _json(
            {
                "status": "ok",
                "review": {
                    "service": pending.service_name,
                    "date": local_date,
                    "start": local_start,
                    "end": local_end,
                    "timezone": review.timezone,
                    "price": shown_price,
                },
                "next": "Tell the visitor the review is shown below your message and that nothing "
                "is booked until they press the Confirm booking button.",
            }
        )
        return ToolOutcome(
            "ok",
            None,
            f"Prepared a review for {pending.service_name} on {local_date} at {local_start}.",
            content,
            review=prepared,
        )
