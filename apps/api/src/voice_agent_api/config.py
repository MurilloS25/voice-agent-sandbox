"""Validated server settings.

Secrets are `SecretStr`: they do not appear in `repr`, messages or logs. Any problem raises
`ConfigError` with a fixed message; only the *names* of the failing settings are logged, never
a value or a length. Validation errors are never chained, because pydantic's carry the input.

Settings come from the process environment and, in development, a git-ignored `.env` file.
`VOICE_AGENT_ENV_FILE` overrides the path (an empty value disables the file).
"""

import base64
import binascii
import logging
import os
import re
import secrets
from typing import Literal

from pydantic import Field, SecretStr, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("voice_agent_api")

ENV_FILE_VARIABLE = "VOICE_AGENT_ENV_FILE"
DEFAULT_ENV_FILE = ".env"
_PLACEHOLDER = "CHANGE_ME"
MIN_SIGNING_KEY_BYTES = 32
MIN_SECRET_CHARS = 32
_MIN_DISTINCT_BYTES = 16


class ConfigError(Exception):
    """Invalid or missing configuration. The message is fixed and reveals nothing."""

    def __init__(self) -> None:
        super().__init__("Server configuration is invalid.")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file_encoding="utf-8", extra="ignore")

    appointment_store: Literal["memory", "postgres"] = "memory"
    business_id: str = "quillwheel"
    proposal_signing_key: SecretStr | None = None

    db_host: str | None = None
    db_port: int = Field(5432, ge=1, le=65535)
    db_name: str = "postgres"
    db_user: str | None = None
    db_password: SecretStr | None = None
    db_sslmode: Literal["verify-full", "require"] = "verify-full"
    db_allow_require_sslmode: bool = False
    db_sslrootcert: str | None = None

    db_pool_max: int = Field(5, ge=1, le=10)
    db_connect_timeout_s: int = Field(3, ge=1, le=30)
    db_pool_timeout_s: float = Field(2.0, gt=0, le=30)
    db_pool_max_waiting: int = Field(20, ge=1, le=1000)
    db_statement_timeout_ms: int = Field(1000, ge=100, le=30000)
    db_lock_timeout_ms: int = Field(1000, ge=100, le=30000)
    db_idle_in_transaction_timeout_ms: int = Field(5000, ge=100, le=60000)

    # Agent turn budget (plan 0003). The defaults are pinned by tests/test_timeout_budget.py.
    agent_turn_deadline_s: float = Field(20.0, gt=1, le=60)
    agent_model_timeout_s: float = Field(8.0, gt=0, le=60)
    agent_tool_timeout_s: float = Field(7.5, gt=0, le=60)

    # Model provider. `disabled` is the default: the app and `secrets check` then need neither a
    # key nor a model, and `POST /v1/agent/turns` answers 503. There is no default model id: it is
    # chosen from the provider's current documentation (ADR 0008) and set in the environment.
    agent_provider: Literal["disabled", "groq"] = "disabled"
    groq_api_key: SecretStr | None = None
    agent_model: str | None = None
    agent_temperature: float = Field(0.0, ge=0, le=2)
    agent_max_output_tokens: int = Field(512, ge=16, le=8192)
    # `off` sends no reasoning-effort parameter.
    agent_reasoning_effort: Literal["off", "low", "medium", "high", "none", "default"] = "low"
    # How model reasoning is kept out of the response: `include_reasoning` sends
    # include_reasoning=false (the gpt-oss family), `reasoning_format` sends
    # reasoning_format=hidden (the qwen family), `none` sends nothing. Reasoning is also dropped
    # by the agent whatever this is set to.
    agent_reasoning_control: Literal["include_reasoning", "reasoning_format", "none"] = (
        "include_reasoning"
    )

    # Voice input (plan 0004). `production` is the default so that nothing enabled by mistake can
    # use the offline fake: `SPEECH_PROVIDER=fake` is accepted only with `APP_ENV` explicitly set
    # to `development` or `test`. `disabled` is the default provider: the speech route then answers
    # 503 and no key or model is needed. There is no default model id (ADR 0009).
    app_env: Literal["development", "test", "production"] = "production"
    speech_provider: Literal["disabled", "fake", "groq"] = "disabled"
    speech_model: str | None = None
    # The upper bounds are the plan's budget: a body read of at most 3 s plus a provider wait of at
    # most 6 s keeps a request inside the 14 s the web client allows (tests/speech/test_budget.py).
    speech_timeout_s: float = Field(6.0, gt=0, le=6.0)
    speech_read_timeout_s: float = Field(3.0, gt=0, le=3.0)
    # 256 KB: 15 s of the browsers' own encodings (Opus or AAC at up to about 136 kbps) with
    # headroom. The upper bound stays at the original 512 KB; the web app's check is pinned to
    # the default by `tests/test_timeout_budget.py` and `apps/web/src/lib/voice/limits.test.ts`.
    speech_max_audio_bytes: int = Field(262_144, ge=1024, le=524_288)
    speech_max_concurrent: int = Field(2, ge=1, le=4)

    # --- Trust boundary (plan 0007) -----------------------------------------------------------
    # The web tier authenticates to the API with a shared secret. `required` is the default and
    # the only mode accepted in production; `disabled` exists for local development and tests.
    api_auth_mode: Literal["required", "disabled"] = "required"
    api_shared_secret: SecretStr | None = None
    # Anything else (a JSON body above this many bytes) is refused before it is parsed.
    json_body_limit_bytes: int = Field(16_384, ge=1024, le=65_536)
    # Tracebacks in logs can carry exception text: only for development and tests.
    log_tracebacks: bool = False

    # Rate limits, requests per minute. Each limit has a per-visitor and an overall value; a
    # bucket holds half a minute's worth. Defaults come from the Groq Free-plan limits (plan
    # 0007): agent turns from 0.7 x 8,000 TPM / about 1,800 tokens per turn = 3 a minute overall;
    # transcriptions from 6 a minute (20 RPM and 7,200 audio seconds an hour allow far more; the
    # budget below is the real brake); the rest are generous for a human.
    rate_limit_enabled: bool = True
    rate_agent_client_per_min: int = Field(3, ge=1, le=600)
    rate_agent_overall_per_min: int = Field(3, ge=1, le=600)
    rate_speech_client_per_min: int = Field(6, ge=1, le=600)
    rate_speech_overall_per_min: int = Field(6, ge=1, le=600)
    rate_write_client_per_min: int = Field(6, ge=1, le=600)
    rate_write_overall_per_min: int = Field(12, ge=1, le=600)
    rate_read_client_per_min: int = Field(60, ge=1, le=600)
    rate_read_overall_per_min: int = Field(300, ge=1, le=6000)
    rate_max_clients: int = Field(5000, ge=100, le=100_000)
    agent_max_in_flight: int = Field(4, ge=1, le=8)

    # Daily provider budget (UTC day). Defaults are half of the Groq Free-plan daily limits
    # (200,000 tokens; 28,800 audio seconds), so a counting error or a restart still leaves
    # margin. A turn reserves `agent_turn_token_reserve` before the model is called and the
    # difference to the real usage is settled afterwards. Audio is charged at the larger of
    # the 10 s minimum Groq bills and the clip's worst-case length: its size divided by
    # `speech_min_bytes_per_second` (the server cannot measure a recording's real length).
    budget_enforced: bool = True
    agent_daily_token_budget: int = Field(100_000, ge=1000, le=10_000_000)
    agent_turn_token_reserve: int = Field(4000, ge=500, le=50_000)
    speech_daily_audio_seconds: int = Field(14_400, ge=10, le=1_000_000)
    speech_min_billed_seconds: int = Field(10, ge=1, le=60)
    speech_min_bytes_per_second: int = Field(3000, ge=500, le=64_000)


def decode_signing_key(value: str) -> bytes:
    """Decode a base64url key and reject weak ones. Raises ValueError (never shown to users)."""
    if _PLACEHOLDER in value.upper():
        raise ValueError("placeholder")
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (binascii.Error, ValueError):
        raise ValueError("encoding") from None
    if base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=") != value:
        raise ValueError("encoding")
    if len(raw) < MIN_SIGNING_KEY_BYTES or len(set(raw)) < _MIN_DISTINCT_BYTES:
        raise ValueError("weak")
    return raw


def generate_signing_key() -> str:
    """A fresh random key in the form `decode_signing_key` accepts."""
    return base64.urlsafe_b64encode(secrets.token_bytes(MIN_SIGNING_KEY_BYTES)).decode().rstrip("=")


def _usable_secret(secret: SecretStr | None) -> bool:
    if secret is None:
        return False
    value = secret.get_secret_value()
    return bool(value) and _PLACEHOLDER not in value.upper()


def _configured_key(settings: Settings) -> SecretStr | None:
    """The signing key, or None. In memory mode an unfilled placeholder counts as unset."""
    key = settings.proposal_signing_key
    if (
        key is not None
        and settings.appointment_store == "memory"
        and _PLACEHOLDER in key.get_secret_value().upper()
    ):
        return None
    return key


_MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/:-]{0,99}")


def failed_agent_settings(settings: Settings) -> list[str]:
    """Names of invalid provider settings. Only when a provider is selected: with `disabled`
    nothing is required (placeholders in `.env` are fine). No key format is assumed, only that it
    is present, not a placeholder and has no whitespace."""
    if settings.agent_provider == "disabled":
        return []
    failed: list[str] = []
    key = settings.groq_api_key
    if not _usable_secret(key) or (key is not None and re.search(r"\s", key.get_secret_value())):
        failed.append("GROQ_API_KEY")
    model = settings.agent_model
    if not model or _PLACEHOLDER in model.upper() or not _MODEL_ID.fullmatch(model):
        failed.append("AGENT_MODEL")
    return failed


def failed_speech_settings(settings: Settings) -> list[str]:
    """Names of invalid speech settings. `disabled` requires nothing (placeholders are ignored).
    `fake` is for tests and offline development only, so it needs `APP_ENV` to be explicitly
    `development` or `test`. `groq` needs a usable key (shared with the agent) and a model."""
    if settings.speech_provider == "disabled":
        return []
    failed: list[str] = []
    if settings.speech_provider == "fake":
        if settings.app_env not in ("development", "test"):
            failed.append("APP_ENV")
        return failed
    key = settings.groq_api_key
    if not _usable_secret(key) or (key is not None and re.search(r"\s", key.get_secret_value())):
        failed.append("GROQ_API_KEY")
    model = settings.speech_model
    if not model or _PLACEHOLDER in model.upper() or not _MODEL_ID.fullmatch(model):
        failed.append("SPEECH_MODEL")
    return failed


# What production accepts. A deployment may lower a limit, never raise it past these.
_PRODUCTION_CEILINGS = {
    "RATE_AGENT_CLIENT_PER_MIN": ("rate_agent_client_per_min", 20),
    "RATE_AGENT_OVERALL_PER_MIN": ("rate_agent_overall_per_min", 20),
    "RATE_SPEECH_CLIENT_PER_MIN": ("rate_speech_client_per_min", 20),
    "RATE_SPEECH_OVERALL_PER_MIN": ("rate_speech_overall_per_min", 20),
    "RATE_WRITE_CLIENT_PER_MIN": ("rate_write_client_per_min", 30),
    "RATE_WRITE_OVERALL_PER_MIN": ("rate_write_overall_per_min", 60),
    "RATE_READ_CLIENT_PER_MIN": ("rate_read_client_per_min", 120),
    "RATE_READ_OVERALL_PER_MIN": ("rate_read_overall_per_min", 600),
}


def _usable_api_secret(settings: Settings) -> bool:
    secret = settings.api_shared_secret
    if not _usable_secret(secret) or secret is None:
        return False
    value = secret.get_secret_value()
    if len(value) < MIN_SECRET_CHARS or re.search(r"\s", value):
        return False
    key = settings.proposal_signing_key
    # One secret per purpose: reusing the signing key would let either leak undo the other.
    return key is None or key.get_secret_value() != value


def failed_security_settings(settings: Settings) -> list[str]:
    """Names of unsafe trust-boundary settings. Production never runs without authentication,
    without rate limits, without budgets, or with limits above the ceilings."""
    failed: list[str] = []
    production = settings.app_env == "production"
    if settings.api_auth_mode == "disabled":
        if production:
            failed.append("API_AUTH_MODE")
    elif not _usable_api_secret(settings):
        failed.append("API_SHARED_SECRET")
    if production:
        if not settings.rate_limit_enabled:
            failed.append("RATE_LIMIT_ENABLED")
        for name, (field, ceiling) in _PRODUCTION_CEILINGS.items():
            if getattr(settings, field) > ceiling:
                failed.append(name)
        # A per-visitor limit above its overall limit would restrict nothing.
        for client_name, (client_field, _) in _PRODUCTION_CEILINGS.items():
            if not client_name.endswith("_CLIENT_PER_MIN") or client_name in failed:
                continue
            overall_field = _PRODUCTION_CEILINGS[client_name.replace("_CLIENT_", "_OVERALL_")][0]
            if getattr(settings, client_field) > getattr(settings, overall_field):
                failed.append(client_name)
        if not settings.budget_enforced:
            failed.append("BUDGET_ENFORCED")
        providers = settings.agent_provider != "disabled" or settings.speech_provider != "disabled"
        # The budget lives in PostgreSQL: with a provider on, it must be checkable.
        if providers and settings.appointment_store != "postgres":
            failed.append("APPOINTMENT_STORE")
        if settings.log_tracebacks:
            failed.append("LOG_TRACEBACKS")
    return failed


def failed_settings(settings: Settings) -> list[str]:
    failed: list[str] = []
    key = _configured_key(settings)
    if key is None:
        if settings.appointment_store == "postgres":
            failed.append("PROPOSAL_SIGNING_KEY")
    else:
        try:
            decode_signing_key(key.get_secret_value())
        except ValueError:
            failed.append("PROPOSAL_SIGNING_KEY")

    failed.extend(n for n in failed_security_settings(settings) if n not in failed)
    failed.extend(failed_agent_settings(settings))
    failed.extend(n for n in failed_speech_settings(settings) if n not in failed)

    if settings.appointment_store == "postgres":
        if not settings.db_host or _PLACEHOLDER in settings.db_host.upper():
            failed.append("DB_HOST")
        if not settings.db_user or _PLACEHOLDER in settings.db_user.upper():
            failed.append("DB_USER")
        if not _usable_secret(settings.db_password):
            failed.append("DB_PASSWORD")
        if settings.db_sslmode == "require" and not settings.db_allow_require_sslmode:
            failed.append("DB_SSLMODE")
        if settings.db_sslmode == "verify-full" and (
            not settings.db_sslrootcert or _PLACEHOLDER in settings.db_sslrootcert.upper()
        ):
            failed.append("DB_SSLROOTCERT")
    return failed


def load_settings(env_file: str | None = None) -> Settings:
    """Load and validate settings. Raises `ConfigError` (generic) on any problem."""
    path = env_file if env_file is not None else os.environ.get(ENV_FILE_VARIABLE, DEFAULT_ENV_FILE)
    try:
        settings = Settings(_env_file=path or None)
    except ValidationError as exc:
        names = sorted({str(err["loc"][0]).upper() for err in exc.errors() if err["loc"]})
        logger.error("Invalid server configuration: %s", ", ".join(names) or "unknown")
        raise ConfigError from None
    return validate_settings(settings)


def validate_settings(settings: Settings) -> Settings:
    failed = failed_settings(settings)
    if failed:
        logger.error("Invalid server configuration: %s", ", ".join(failed))
        raise ConfigError
    return settings


def resolve_signing_key(settings: Settings) -> bytes:
    """The configured key, or an ephemeral random one in memory mode when none is set."""
    key = _configured_key(settings)
    if key is None:
        if settings.appointment_store == "postgres":
            raise ConfigError
        return secrets.token_bytes(MIN_SIGNING_KEY_BYTES)
    try:
        return decode_signing_key(key.get_secret_value())
    except ValueError:
        raise ConfigError from None
