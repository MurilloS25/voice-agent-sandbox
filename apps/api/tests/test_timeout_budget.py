"""The web client's timeouts must exceed the API's worst case, with margin.

The worst case, for a database that is slow but answering, is the pool-acquire timeout plus
one statement timeout for every statement in a request, counting the `set_config` preamble and
the commit. This reads the real defaults, so changing either side without the other fails here.
"""

import re
from pathlib import Path

from voice_agent_api.config import Settings

CLIENT_TS = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "api" / "client.ts"
# About 2 s for Node, rendering and the network, plus 3 s of slack.
MARGIN_S = 5.0

# Statements per transaction, including the preamble and the commit.
DAY_VIEW_STATEMENTS = 1 + 3 + 1  # preamble, business+service, hours, bookings, commit
CONFIRM_STATEMENTS = (
    1 + 6 + 1
)  # preamble, business+service, hours, lock, replay, bookings, insert, commit


def web_timeout_s(name: str) -> float:
    match = re.search(rf"export const {name} = (\d+);", CLIENT_TS.read_text("utf-8"))
    assert match, f"{name} not found in client.ts"
    return int(match.group(1)) / 1000


def test_web_read_budget_covers_the_slowest_read_with_margin() -> None:
    s = Settings(_env_file=None)
    worst = s.db_pool_timeout_s + DAY_VIEW_STATEMENTS * s.db_statement_timeout_ms / 1000
    assert worst == 7.0
    assert web_timeout_s("READ_TIMEOUT_MS") >= worst + MARGIN_S


def test_web_write_budget_covers_proposal_and_confirm_with_margin() -> None:
    s = Settings(_env_file=None)
    statement_s = s.db_statement_timeout_ms / 1000
    confirm = s.db_pool_timeout_s + CONFIRM_STATEMENTS * statement_s
    proposal = s.db_pool_timeout_s + DAY_VIEW_STATEMENTS * statement_s
    assert confirm == 10.0
    assert web_timeout_s("MUTATION_TIMEOUT_MS") >= max(confirm, proposal) + MARGIN_S


def test_a_lock_wait_is_never_longer_than_a_statement() -> None:
    s = Settings(_env_file=None)
    # The advisory-lock wait is one of the statements counted above, so it must fit in one.
    assert s.db_lock_timeout_ms <= s.db_statement_timeout_ms


def test_agent_turn_budget_is_exact_and_bounded_by_the_deadline() -> None:
    from voice_agent_api.agent.limits import COMMIT_ALLOWANCE_S, WEB_MARGIN_S, AgentLimits

    s = Settings(_env_file=None)
    limits = AgentLimits.from_settings(s)

    assert limits == AgentLimits()  # the settings defaults are the dataclass defaults
    # Without a deadline: 1 prompt read + 4 model calls + 3 tool calls = 7.5 + 32 + 22.5 s.
    uncapped = (
        s.agent_tool_timeout_s
        + limits.max_model_calls * s.agent_model_timeout_s
        + limits.max_tool_calls * s.agent_tool_timeout_s
    )
    assert uncapped == 62.0
    assert s.agent_turn_deadline_s < uncapped  # the deadline, not the call counts, is the bound
    assert limits.server_bound_s == s.agent_turn_deadline_s + COMMIT_ALLOWANCE_S == 21.0
    assert limits.web_timeout_s == limits.server_bound_s + WEB_MARGIN_S == 26.0
    assert WEB_MARGIN_S == MARGIN_S  # the same margin as the booking requests


def test_agent_per_call_limits_fit_inside_the_turn_and_the_database_worst_case() -> None:
    from voice_agent_api.agent.limits import AgentLimits

    s = Settings(_env_file=None)
    limits = AgentLimits.from_settings(s)
    one_day_view = s.db_pool_timeout_s + DAY_VIEW_STATEMENTS * s.db_statement_timeout_ms / 1000

    assert s.agent_model_timeout_s <= s.agent_turn_deadline_s
    assert s.agent_tool_timeout_s >= one_day_view  # one slow-but-answering day query completes
    assert limits.min_call_start_s >= 1.0
    assert limits.recursion_limit >= 2 * limits.max_model_calls + 2
    assert limits.max_tool_calls <= limits.max_model_calls
    assert limits.max_in_flight_turns <= s.db_pool_max  # agent pressure stays below the pool


def test_the_web_client_agent_timeout_matches_the_server_bound_plus_the_margin() -> None:
    from voice_agent_api.agent.limits import AgentLimits

    limits = AgentLimits.from_settings(Settings(_env_file=None))
    assert web_timeout_s("AGENT_TURN_TIMEOUT_MS") == limits.web_timeout_s == 26.0
    assert web_timeout_s("AGENT_TURN_TIMEOUT_MS") > limits.server_bound_s  # strictly greater
