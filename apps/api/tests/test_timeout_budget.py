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
