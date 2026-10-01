"""A compact fingerprint of the catalog values a reviewed booking depends on.

It is compared, never trusted: every appointment value is recomputed from the current catalog.
Fields: fingerprint version, business id, timezone, currency, service id, name, duration,
price amount and price currency. Hours, grid, lead time, horizon and bench count are left out
because `check_slot` re-validates them (a change yields slot_not_offered or slot_unavailable,
never a different booking). The service description is not shown in the review.
"""

import base64
import hashlib
import hmac
import json

from voice_agent_api.domain.models import Business, Service

_VERSION = 1


def catalog_fingerprint(business: Business, service: Service) -> str:
    canonical = json.dumps(
        {
            "v": _VERSION,
            "business_id": business.id,
            "timezone": business.timezone.key,
            "currency": business.currency,
            "service_id": service.id,
            "service_name": service.name,
            "duration_seconds": int(service.duration.total_seconds()),
            "price_amount_minor": service.price.amount_minor,
            "price_currency": service.price.currency,
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    )
    digest = hashlib.sha256(canonical.encode("ascii")).digest()[:16]
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def fingerprints_match(expected: str, actual: str) -> bool:
    """Constant-time comparison."""
    return hmac.compare_digest(expected.encode("utf-8"), actual.encode("utf-8"))
