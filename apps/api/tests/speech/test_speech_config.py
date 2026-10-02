"""Speech settings: defaults, fail-closed validation, the fake's production lock, and wiring."""

import logging
from collections.abc import Iterator
from typing import Any

import pytest
from pydantic import SecretStr

from tests.speech.support import audio, request
from voice_agent_api.config import ConfigError, Settings, load_settings, validate_settings
from voice_agent_api.factory import build_speech, create_app_from_settings
from voice_agent_api.speech.bounded import SpeechService
from voice_agent_api.speech.fake import ScriptedSpeechToText
from voice_agent_api.speech.limits import SpeechLimits
from voice_agent_api.speech.providers import GroqSpeechToText, build_speech_to_text

GENERIC = "Server configuration is invalid."
KEY = "fake-offline-credential-for-tests-0001"
ENV_NAMES = [
    "APP_ENV",
    "SPEECH_PROVIDER",
    "SPEECH_MODEL",
    "SPEECH_TIMEOUT_S",
    "SPEECH_READ_TIMEOUT_S",
    "SPEECH_MAX_AUDIO_BYTES",
    "SPEECH_MAX_CONCURRENT",
    "GROQ_API_KEY",
    "VOICE_AGENT_ENV_FILE",
]


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    for name in ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    yield


from tests.conftest import TEST_API_SECRET  # noqa: E402


def make(**overrides: Any) -> Settings:
    return Settings(_env_file=None, **overrides)


def groq(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "speech_provider": "groq",
        "groq_api_key": SecretStr(KEY),
        "speech_model": "some/whisper-model",
        "app_env": "test",  # production also needs PostgreSQL for the budget (plan 0007)
    }
    values.update(overrides)
    return make(**values)


def test_defaults_are_production_and_disabled_with_no_model() -> None:
    settings = validate_settings(make())
    assert settings.app_env == "production"
    assert settings.speech_provider == "disabled"
    assert settings.speech_model is None
    assert SpeechLimits.from_settings(settings) == SpeechLimits()  # the plan's budget


def test_disabled_needs_nothing_and_ignores_placeholders() -> None:
    settings = make(speech_model="CHANGE_ME", groq_api_key=SecretStr("CHANGE_ME"))
    assert validate_settings(settings).speech_provider == "disabled"
    assert build_speech_to_text(settings) is None
    assert build_speech(settings) is None


@pytest.mark.parametrize("env", ["development", "test"])
def test_the_fake_is_accepted_only_in_an_explicit_development_or_test_environment(
    env: str,
) -> None:
    settings = validate_settings(make(speech_provider="fake", app_env=env))
    port = build_speech_to_text(settings)
    assert isinstance(port, ScriptedSpeechToText)


@pytest.mark.parametrize("overrides", [{}, {"app_env": "production"}])
def test_the_fake_is_refused_in_production_by_name_only(
    overrides: dict[str, Any], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="voice_agent_api")
    settings = make(speech_provider="fake", **overrides)  # APP_ENV defaults to production
    with pytest.raises(ConfigError) as caught:
        validate_settings(settings)
    assert str(caught.value) == GENERIC
    assert "APP_ENV" in " ".join(r.getMessage() for r in caplog.records)


def test_the_fake_is_refused_in_production_even_when_validation_is_bypassed() -> None:
    settings = make(speech_provider="fake", app_env="production")
    with pytest.raises(ConfigError):
        build_speech_to_text(settings)
    with pytest.raises(ConfigError):
        create_app_from_settings(settings)


def test_the_fake_is_refused_from_the_environment_too(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SPEECH_PROVIDER", "fake")
    with pytest.raises(ConfigError):
        load_settings(env_file="")
    monkeypatch.setenv("APP_ENV", "development")
    assert load_settings(env_file="").speech_provider == "fake"


def test_a_complete_groq_selection_passes_without_the_agent() -> None:
    settings = validate_settings(groq())  # the agent provider stays disabled
    assert settings.agent_provider == "disabled" and settings.speech_provider == "groq"
    assert isinstance(build_speech_to_text(settings), GroqSpeechToText)


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"groq_api_key": None}, ["GROQ_API_KEY"]),
        ({"groq_api_key": SecretStr("CHANGE_ME")}, ["GROQ_API_KEY"]),
        ({"groq_api_key": SecretStr("two words")}, ["GROQ_API_KEY"]),
        ({"speech_model": None}, ["SPEECH_MODEL"]),
        ({"speech_model": ""}, ["SPEECH_MODEL"]),
        ({"speech_model": "CHANGE_ME"}, ["SPEECH_MODEL"]),
        ({"speech_model": "bad model!"}, ["SPEECH_MODEL"]),
        ({"groq_api_key": None, "speech_model": None}, ["GROQ_API_KEY", "SPEECH_MODEL"]),
    ],
)
def test_groq_fails_closed_naming_only_the_setting(
    overrides: dict[str, Any], expected: list[str], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="voice_agent_api")
    with pytest.raises(ConfigError) as caught:
        validate_settings(groq(**overrides))
    assert str(caught.value) == GENERIC
    logged = " ".join(r.getMessage() for r in caplog.records)
    for name in expected:
        assert name in logged
    for value in (KEY, "some/whisper-model", "two words", "bad model"):
        assert value not in logged


def test_a_shared_key_failure_is_named_once() -> None:
    from voice_agent_api.config import failed_settings

    both = make(
        agent_provider="groq",
        agent_model="some/model-id",
        speech_provider="groq",
        speech_model="some/whisper-model",
    )
    assert failed_settings(both).count("GROQ_API_KEY") == 1


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("SPEECH_PROVIDER", "openai"),
        ("APP_ENV", "staging"),
        ("SPEECH_TIMEOUT_S", "7"),  # above the plan's 6 s: the web budget would no longer hold
        ("SPEECH_TIMEOUT_S", "0"),
        ("SPEECH_READ_TIMEOUT_S", "4"),
        ("SPEECH_MAX_AUDIO_BYTES", "524289"),
        ("SPEECH_MAX_AUDIO_BYTES", "10"),
        ("SPEECH_MAX_CONCURRENT", "0"),
        ("SPEECH_MAX_CONCURRENT", "5"),
    ],
)
def test_out_of_range_speech_options_are_a_generic_config_error(
    monkeypatch: pytest.MonkeyPatch, name: str, value: str
) -> None:
    monkeypatch.setenv(name, value)
    with pytest.raises(ConfigError) as caught:
        load_settings(env_file="")
    assert str(caught.value) == GENERIC


def test_limits_can_be_lowered_but_never_above_the_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SPEECH_TIMEOUT_S", "2.5")
    monkeypatch.setenv("SPEECH_READ_TIMEOUT_S", "1")
    monkeypatch.setenv("SPEECH_MAX_AUDIO_BYTES", "65536")
    monkeypatch.setenv("SPEECH_MAX_CONCURRENT", "1")
    limits = SpeechLimits.from_settings(load_settings(env_file=""))
    assert limits == SpeechLimits(65536, 1.0, 2.5, 1)
    assert limits.web_timeout_s <= SpeechLimits().web_timeout_s


def test_the_app_built_from_settings_serves_the_fake_and_closes_it() -> None:
    import asyncio

    settings = make(speech_provider="fake", app_env="test")
    app = create_app_from_settings(settings)
    service = app.state.speech
    assert isinstance(service, SpeechService)
    data, headers = audio("audio/wav")
    headers = {**headers, "authorization": f"Bearer {TEST_API_SECRET}"}
    try:
        response = request(app, data, headers)
    finally:
        service.close()
    assert response.status_code == 200 and response.json()["language"] == "en"
    assert asyncio.run(_closed_is_unavailable(service))


async def _closed_is_unavailable(service: SpeechService) -> bool:
    from voice_agent_api.speech.contracts import AudioClip
    from voice_agent_api.speech.errors import SpeechUnavailable

    try:
        await service.transcribe(AudioClip(data=b"x", media_type="audio/wav"))
    except SpeechUnavailable:
        return True
    return False


def test_the_app_built_from_default_settings_has_no_speech_and_answers_503() -> None:
    app = create_app_from_settings(make())
    assert app.state.speech is None
    data, headers = audio("audio/wav")
    headers = {**headers, "authorization": f"Bearer {TEST_API_SECRET}"}
    response = request(app, data, headers)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "speech_unavailable"
