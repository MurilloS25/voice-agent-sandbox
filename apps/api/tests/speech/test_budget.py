"""The speech timeout budget (plan 0004). The matching web constant arrives with the capture UI
(phase 4C); this pins the server side and the margin it will have to use."""

from voice_agent_api.agent.limits import WEB_MARGIN_S as AGENT_WEB_MARGIN_S
from voice_agent_api.config import Settings
from voice_agent_api.speech.limits import MAX_DECLARED_DURATION_MS, WEB_MARGIN_S, SpeechLimits


def test_the_server_bound_is_the_body_read_plus_the_provider_wait() -> None:
    limits = SpeechLimits()
    assert limits.read_timeout_s == 3.0
    assert limits.provider_timeout_s == 6.0
    assert limits.server_bound_s == 9.0


def test_the_web_budget_is_the_server_bound_plus_the_shared_margin() -> None:
    limits = SpeechLimits()
    assert WEB_MARGIN_S == AGENT_WEB_MARGIN_S == 5.0  # the same margin as booking and agent turns
    assert limits.web_timeout_s == limits.server_bound_s + WEB_MARGIN_S == 14.0
    assert limits.web_timeout_s > limits.server_bound_s  # strictly greater


def test_the_defaults_match_the_plan() -> None:
    limits = SpeechLimits()
    assert limits.max_audio_bytes == 512 * 1024
    assert limits.max_concurrent == 2
    assert MAX_DECLARED_DURATION_MS == 60_000
    assert limits.provider_timeout_s < limits.server_bound_s  # time is left for the read


def test_the_settings_defaults_and_caps_are_the_plan_budget() -> None:
    settings = Settings(_env_file=None)
    assert SpeechLimits.from_settings(settings) == SpeechLimits()
    # The caps are the defaults: configuration can only lower the budget, so the web timeout
    # (server bound plus margin) always covers the slowest configured request.
    fields = Settings.model_fields
    caps = {
        name: next(m.le for m in fields[name].metadata if hasattr(m, "le"))
        for name in ("speech_timeout_s", "speech_read_timeout_s", "speech_max_audio_bytes")
    }
    assert caps == {
        "speech_timeout_s": 6.0,
        "speech_read_timeout_s": 3.0,
        "speech_max_audio_bytes": 524_288,
    }
    assert caps["speech_timeout_s"] + caps["speech_read_timeout_s"] == SpeechLimits().server_bound_s
