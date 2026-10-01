import base64
import logging
import secrets
from collections.abc import Iterator
from pathlib import Path

import pytest
from pydantic import SecretStr

from voice_agent_api.config import (
    ConfigError,
    Settings,
    decode_signing_key,
    generate_signing_key,
    load_settings,
    resolve_signing_key,
    validate_settings,
)

GENERIC = "Server configuration is invalid."
ENV_NAMES = [
    "APPOINTMENT_STORE",
    "BUSINESS_ID",
    "PROPOSAL_SIGNING_KEY",
    "VOICE_AGENT_ENV_FILE",
    *(f"DB_{n}" for n in ("HOST", "PORT", "NAME", "USER", "PASSWORD", "SSLMODE", "SSLROOTCERT")),
    "DB_ALLOW_REQUIRE_SSLMODE",
    "DB_POOL_MAX",
]


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    for name in ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    yield


def postgres_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "appointment_store": "postgres",
        "proposal_signing_key": SecretStr(generate_signing_key()),
        "db_host": "db.example.invalid",
        "db_user": "voice_agent_api.exampleref",
        "db_password": SecretStr(secrets.token_urlsafe(32)),
        "db_sslrootcert": "/certs/ca.pem",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)  # type: ignore[arg-type]


def test_memory_mode_needs_no_secrets_and_gets_an_ephemeral_key() -> None:
    settings = validate_settings(Settings(_env_file=None))
    assert settings.appointment_store == "memory"
    first, second = resolve_signing_key(settings), resolve_signing_key(settings)
    assert len(first) == 32 and first != second


def test_valid_postgres_settings_pass_and_use_the_configured_key() -> None:
    settings = validate_settings(postgres_settings())
    assert resolve_signing_key(settings) == resolve_signing_key(settings)


@pytest.mark.parametrize(
    ("overrides", "name"),
    [
        ({"proposal_signing_key": None}, "PROPOSAL_SIGNING_KEY"),
        ({"proposal_signing_key": SecretStr("")}, "PROPOSAL_SIGNING_KEY"),
        ({"proposal_signing_key": SecretStr("tooshort")}, "PROPOSAL_SIGNING_KEY"),
        (
            {"proposal_signing_key": SecretStr(base64.urlsafe_b64encode(bytes(32)).decode())},
            "PROPOSAL_SIGNING_KEY",
        ),  # 32 repeated bytes
        (
            {"proposal_signing_key": SecretStr(base64.urlsafe_b64encode(b"ab" * 16).decode())},
            "PROPOSAL_SIGNING_KEY",
        ),  # only two distinct byte values
        ({"proposal_signing_key": SecretStr("CHANGE_ME")}, "PROPOSAL_SIGNING_KEY"),
        ({"proposal_signing_key": SecretStr("not base64 !!!" * 4)}, "PROPOSAL_SIGNING_KEY"),
        ({"db_password": None}, "DB_PASSWORD"),
        ({"db_password": SecretStr("")}, "DB_PASSWORD"),
        ({"db_password": SecretStr("CHANGE_ME")}, "DB_PASSWORD"),
        ({"db_host": None}, "DB_HOST"),
        ({"db_user": None}, "DB_USER"),
        ({"db_sslrootcert": None}, "DB_SSLROOTCERT"),
        ({"db_sslmode": "require"}, "DB_SSLMODE"),
    ],
)
def test_bad_postgres_settings_fail_with_a_generic_error(
    overrides: dict[str, object], name: str, caplog: pytest.LogCaptureFixture
) -> None:
    settings = postgres_settings(**overrides)
    with caplog.at_level(logging.DEBUG), pytest.raises(ConfigError) as raised:
        validate_settings(settings)

    assert str(raised.value) == GENERIC
    assert name in caplog.text  # only the name of the failing setting is logged
    for secret in (settings.proposal_signing_key, settings.db_password):
        if secret is not None and len(secret.get_secret_value()) > 6:
            assert secret.get_secret_value() not in caplog.text
            assert secret.get_secret_value() not in str(raised.value)


def test_a_weak_key_is_rejected_even_in_memory_mode() -> None:
    settings = Settings(_env_file=None, proposal_signing_key=SecretStr("weak"))
    with pytest.raises(ConfigError):
        validate_settings(settings)
    with pytest.raises(ConfigError):
        resolve_signing_key(settings)


def test_require_sslmode_needs_an_explicit_opt_in() -> None:
    validate_settings(postgres_settings(db_sslmode="require", db_allow_require_sslmode=True))


def test_secrets_never_appear_in_repr_or_str() -> None:
    settings = postgres_settings()
    assert settings.db_password is not None and settings.proposal_signing_key is not None
    for text in (repr(settings), str(settings)):
        assert settings.db_password.get_secret_value() not in text
        assert settings.proposal_signing_key.get_secret_value() not in text


def test_generated_keys_pass_validation_and_are_32_bytes() -> None:
    for _ in range(20):
        assert len(decode_signing_key(generate_signing_key())) == 32


def test_invalid_field_values_raise_a_generic_error_without_chaining(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("DB_PORT", "hunter2-not-a-port")
    with caplog.at_level(logging.DEBUG), pytest.raises(ConfigError) as raised:
        load_settings(env_file="")
    assert str(raised.value) == GENERIC
    assert raised.value.__cause__ is None and raised.value.__suppress_context__
    assert "hunter2" not in caplog.text
    assert "DB_PORT" in caplog.text


def test_settings_load_from_an_env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    key = generate_signing_key()
    env = tmp_path / ".env"
    env.write_text(f"PROPOSAL_SIGNING_KEY={key}\nAPPOINTMENT_STORE=memory\n", encoding="utf-8")
    settings = load_settings(env_file=str(env))
    assert settings.proposal_signing_key is not None
    assert settings.proposal_signing_key.get_secret_value() == key


def test_the_env_file_variable_can_disable_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / ".env").write_text("APPOINTMENT_STORE=postgres\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("VOICE_AGENT_ENV_FILE", "")
    assert load_settings().appointment_store == "memory"
