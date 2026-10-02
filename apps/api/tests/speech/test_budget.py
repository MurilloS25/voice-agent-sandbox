"""The speech timeout budget (plan 0004). The matching web constant arrives with the capture UI
(phase 4C); this pins the server side and the margin it will have to use."""

from voice_agent_api.agent.limits import WEB_MARGIN_S as AGENT_WEB_MARGIN_S
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
