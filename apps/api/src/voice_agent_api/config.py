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
import secrets
from typing import Literal

from pydantic import Field, SecretStr, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("voice_agent_api")

ENV_FILE_VARIABLE = "VOICE_AGENT_ENV_FILE"
DEFAULT_ENV_FILE = ".env"
_PLACEHOLDER = "CHANGE_ME"
MIN_SIGNING_KEY_BYTES = 32
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
