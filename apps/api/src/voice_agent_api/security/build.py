"""Turn validated settings into the protection layer. No network, no file."""

import time
from collections.abc import Callable

from voice_agent_api.config import ConfigError, Settings
from voice_agent_api.security.auth import secret_digest
from voice_agent_api.security.middleware import Protection
from voice_agent_api.security.ratelimit import Category, CategoryLimits, Policy, RateLimits


def build_rate_limits(
    settings: Settings, clock: Callable[[], float] = time.monotonic
) -> RateLimits | None:
    if not settings.rate_limit_enabled:
        return None
    s = settings
    limits = {
        Category.AGENT: CategoryLimits(
            Policy.per_minute(s.rate_agent_client_per_min),
            Policy.per_minute(s.rate_agent_overall_per_min),
        ),
        Category.SPEECH: CategoryLimits(
            Policy.per_minute(s.rate_speech_client_per_min),
            Policy.per_minute(s.rate_speech_overall_per_min),
        ),
        Category.WRITE: CategoryLimits(
            Policy.per_minute(s.rate_write_client_per_min),
            Policy.per_minute(s.rate_write_overall_per_min),
        ),
        Category.READ: CategoryLimits(
            Policy.per_minute(s.rate_read_client_per_min),
            Policy.per_minute(s.rate_read_overall_per_min),
        ),
    }
    return RateLimits(limits, clock, max_clients=s.rate_max_clients)


def build_protection(settings: Settings, clock: Callable[[], float] = time.monotonic) -> Protection:
    """Authentication is on unless the (non-production) mode says otherwise; validation has
    already refused a missing secret."""
    digest: bytes | None = None
    if settings.api_auth_mode == "required":
        secret = settings.api_shared_secret
        if secret is None:
            raise ConfigError  # never serve without the secret the settings promise
        digest = secret_digest(secret.get_secret_value())
    return Protection(
        secret_digest=digest,
        limits=build_rate_limits(settings, clock),
        json_body_limit=settings.json_body_limit_bytes,
    )
