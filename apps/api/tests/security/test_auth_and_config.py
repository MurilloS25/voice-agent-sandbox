"""Server-to-server authentication, public paths, docs and the production configuration rules."""

import hmac
from typing import Any

import pytest
from pydantic import SecretStr

from tests.conftest import TEST_API_SECRET
from tests.security.support import AUTH, SECRET, Protected
from voice_agent_api.config import (
    ConfigError,
    Settings,
    failed_settings,
    validate_settings,
)
from voice_agent_api.security import auth

URLS = [
    ("GET", "/v1/business"),
    ("GET", "/v1/services"),
    ("GET", "/v1/services/flat-repair/availability?date=2026-10-06"),
    ("POST", "/v1/appointment-proposals"),
    ("POST", "/v1/appointments"),
    ("GET", "/v1/appointments/00000000-0000-4000-8000-000000000001"),
    ("POST", "/v1/agent/turns"),
    ("POST", "/v1/speech/transcriptions"),
    ("GET", "/health/ready-not-a-route"),
    ("GET", "/anything-else"),
    ("GET", "/docs"),
    ("GET", "/openapi.json"),
]


@pytest.mark.parametrize(("method", "url"), URLS)
def test_every_route_but_health_refuses_a_caller_without_the_secret(method: str, url: str) -> None:
    api = Protected()
    response = api.client.request(method, url)
    assert response.status_code == 401
    assert response.json() == {
        "error": {"code": "unauthorized", "message": "Authentication is required."}
    }


@pytest.mark.parametrize(
    "header",
    [
        "Bearer wrong-secret-0123456789-abcdefghijklmnopqrstuv",
        f"Bearer {SECRET} ",
        f"Basic {SECRET}",
        f"Bearer{SECRET}",
        f"bearer  {SECRET}",
        "Bearer ",
        "",
        SECRET,
    ],
)
def test_a_wrong_or_malformed_credential_gets_the_same_generic_answer(header: str) -> None:
    api = Protected()
    missing = api.client.get("/v1/business")
    wrong = api.client.get("/v1/business", headers={"Authorization": header})
    assert wrong.status_code == 401
    assert wrong.content == missing.content  # nothing says which part was wrong


def test_the_secret_is_accepted_only_in_the_authorization_header() -> None:
    api = Protected()
    assert api.client.get("/v1/business", params={"token": SECRET}).status_code == 401
    assert api.client.get("/v1/business", params={"access_token": SECRET}).status_code == 401
    assert api.client.get("/v1/business", headers={"X-Api-Key": SECRET}).status_code == 401
    assert api.client.get("/v1/business", headers={"Cookie": f"secret={SECRET}"}).status_code == 401
    assert api.client.get("/v1/business", headers=AUTH).status_code == 200


def test_the_scheme_is_case_insensitive_but_the_secret_is_exact() -> None:
    api = Protected()
    assert (
        api.client.get("/v1/business", headers={"Authorization": f"bearer {SECRET}"}).status_code
        == 200
    )
    assert (
        api.client.get(
            "/v1/business", headers={"Authorization": f"Bearer {SECRET.upper()}"}
        ).status_code
        == 401
    )


@pytest.mark.parametrize("path", ["/health", "/health/live", "/health/ready"])
def test_health_is_public_and_says_only_a_status_word(path: str) -> None:
    api = Protected()
    response = api.client.get(path)
    assert response.status_code == 200
    assert list(response.json()) == ["status"]
    assert response.headers.get("cache-control") != "public"


def test_only_get_and_head_of_the_health_paths_are_public() -> None:
    api = Protected()
    assert api.client.post("/health/live").status_code == 401
    assert api.client.get("/health/live/extra").status_code == 401
    assert api.client.get("/health/").status_code == 401


def test_the_comparison_is_constant_time(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[int, int]] = []
    real = hmac.compare_digest

    def spy(a: Any, b: Any) -> bool:
        calls.append((len(a), len(b)))
        return real(a, b)

    monkeypatch.setattr(hmac, "compare_digest", spy)
    digest = auth.secret_digest(SECRET)
    assert auth.is_authorized(digest, f"Bearer {SECRET}") is True
    assert auth.is_authorized(digest, "Bearer x") is False
    assert auth.is_authorized(digest, None) is False
    # Always two SHA-256 digests of the same length, whatever was presented: the secret's length
    # and the position of the first wrong byte never show in the timing.
    assert calls == [(32, 32)] * 3


def test_a_missing_credential_still_goes_through_the_comparison(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[int] = []
    real = hmac.compare_digest

    def spy(a: Any, b: Any) -> bool:
        calls.append(1)
        return real(a, b)

    monkeypatch.setattr(hmac, "compare_digest", spy)
    auth.is_authorized(auth.secret_digest(SECRET), None)
    assert calls == [1]


def test_authentication_can_be_off_only_when_the_app_is_built_that_way() -> None:
    api = Protected(auth=False)
    assert api.client.get("/v1/business").status_code == 200


def test_the_interactive_docs_and_the_schema_are_off_when_disabled() -> None:
    api = Protected(docs_enabled=False)
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert api.client.get(path, headers=AUTH).status_code == 404


def test_the_interactive_docs_exist_when_enabled() -> None:
    api = Protected(docs_enabled=True)
    assert api.client.get("/openapi.json", headers=AUTH).status_code == 200


# --- configuration: production fails closed -------------------------------------------------


def make(**overrides: Any) -> Settings:
    return Settings(_env_file=None, **overrides)


def test_production_is_the_default_and_the_test_secret_makes_it_valid() -> None:
    settings = validate_settings(make())
    assert settings.app_env == "production"
    assert settings.api_auth_mode == "required"
    assert settings.rate_limit_enabled and settings.budget_enforced


@pytest.mark.parametrize(
    "secret",
    [
        None,
        SecretStr(""),
        SecretStr("CHANGE_ME"),
        SecretStr("short"),
        SecretStr("x" * 31),
        SecretStr("has a space " + "x" * 30),
        SecretStr("line\nbreak" + "x" * 30),
    ],
)
def test_production_refuses_a_missing_or_weak_shared_secret(secret: SecretStr | None) -> None:
    assert "API_SHARED_SECRET" in failed_settings(make(api_shared_secret=secret))
    with pytest.raises(ConfigError):
        validate_settings(make(api_shared_secret=secret))


def test_the_shared_secret_must_differ_from_the_signing_key() -> None:
    from voice_agent_api.config import generate_signing_key

    key = generate_signing_key()
    settings = make(proposal_signing_key=SecretStr(key), api_shared_secret=SecretStr(key))
    assert "API_SHARED_SECRET" in failed_settings(settings)


def test_the_failure_names_the_setting_and_never_the_value(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level("DEBUG", logger="voice_agent_api")
    with pytest.raises(ConfigError) as caught:
        validate_settings(make(api_shared_secret=SecretStr("too-short")))
    logged = " ".join(r.getMessage() for r in caplog.records)
    assert "API_SHARED_SECRET" in logged and "too-short" not in logged
    assert "too-short" not in str(caught.value)


def test_production_refuses_to_run_without_authentication() -> None:
    assert "API_AUTH_MODE" in failed_settings(make(api_auth_mode="disabled"))


@pytest.mark.parametrize("env", ["development", "test"])
def test_development_and_test_may_turn_authentication_off_explicitly(env: str) -> None:
    settings = validate_settings(
        make(app_env=env, api_auth_mode="disabled", api_shared_secret=None)
    )
    assert settings.api_auth_mode == "disabled"


def test_without_an_explicit_off_switch_even_development_needs_the_secret() -> None:
    assert "API_SHARED_SECRET" in failed_settings(
        make(app_env="development", api_shared_secret=None)
    )


def test_production_refuses_unsafe_limits_and_switches() -> None:
    assert failed_settings(make(rate_limit_enabled=False)) == ["RATE_LIMIT_ENABLED"]
    assert failed_settings(make(budget_enforced=False)) == ["BUDGET_ENFORCED"]
    assert failed_settings(make(log_tracebacks=True)) == ["LOG_TRACEBACKS"]
    assert failed_settings(make(rate_agent_client_per_min=21)) == ["RATE_AGENT_CLIENT_PER_MIN"]
    assert failed_settings(make(rate_agent_overall_per_min=21)) == ["RATE_AGENT_OVERALL_PER_MIN"]
    assert failed_settings(make(rate_speech_client_per_min=21)) == ["RATE_SPEECH_CLIENT_PER_MIN"]
    assert failed_settings(make(rate_read_overall_per_min=601)) == ["RATE_READ_OVERALL_PER_MIN"]


def test_development_may_raise_the_limits_and_use_tracebacks() -> None:
    settings = make(app_env="development", rate_agent_client_per_min=100, log_tracebacks=True)
    assert failed_settings(settings) == []


def test_a_provider_in_production_needs_postgres_for_the_budget() -> None:
    settings = make(
        agent_provider="groq",
        groq_api_key=SecretStr("fake-offline-credential-for-tests-0001"),
        agent_model="some/model-id",
    )
    assert failed_settings(settings) == ["APPOINTMENT_STORE"]


def test_the_api_secret_comes_from_the_environment_only_by_name() -> None:
    assert Settings.model_fields["api_shared_secret"].annotation == SecretStr | None
    assert TEST_API_SECRET not in repr(make())
