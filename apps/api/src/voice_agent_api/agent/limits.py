"""Budgets for one agent turn (plan 0003, "Timeout budget").

Worst case from route entry to response is `turn_deadline_s + COMMIT_ALLOWANCE_S` = 21 s with the
defaults. Every model call, tool call and the prompt catalog read waits at most
`min(per-call limit, time left)` and is not started with less than `min_call_start_s` left, so
the time spent in calls is capped by the deadline whatever the call counts. The web client
allows that bound plus `WEB_MARGIN_S` (26 s).
"""

from dataclasses import dataclass

from voice_agent_api.config import Settings

COMMIT_ALLOWANCE_S = 1.0
WEB_MARGIN_S = 5.0


@dataclass(frozen=True)
class AgentLimits:
    turn_deadline_s: float = 20.0
    model_timeout_s: float = 8.0
    tool_timeout_s: float = 7.5
    min_call_start_s: float = 1.0
    max_model_calls: int = 4
    max_tool_calls: int = 3
    recursion_limit: int = 10
    max_in_flight_turns: int = 4
    history_messages: int = 16
    max_slots_offered: int = 10
    max_reply_chars: int = 1200

    @classmethod
    def from_settings(cls, settings: Settings) -> "AgentLimits":
        return cls(
            turn_deadline_s=settings.agent_turn_deadline_s,
            model_timeout_s=settings.agent_model_timeout_s,
            tool_timeout_s=settings.agent_tool_timeout_s,
            max_in_flight_turns=settings.agent_max_in_flight,
        )

    @property
    def server_bound_s(self) -> float:
        return self.turn_deadline_s + COMMIT_ALLOWANCE_S

    @property
    def web_timeout_s(self) -> float:
        return self.server_bound_s + WEB_MARGIN_S
