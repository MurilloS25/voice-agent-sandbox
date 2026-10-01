"""Presentation helpers. Times are UTC internally; local business time is applied here only."""

from datetime import datetime
from zoneinfo import ZoneInfo

from voice_agent_api.domain.models import Money

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def local_parts(moment: datetime, tz: ZoneInfo) -> tuple[str, str, str]:
    """(ISO date, weekday name, HH:MM) of an instant in the business timezone."""
    local = moment.astimezone(tz)
    return local.date().isoformat(), WEEKDAYS[local.weekday()], local.strftime("%H:%M")


def price_display(price: Money) -> str:
    return f"{price.amount_minor / 100:.2f} {price.currency}"
