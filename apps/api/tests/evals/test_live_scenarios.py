"""The live evaluation: real model calls, paced, once (plan 0003, checkpoint C5).

Run it deliberately, from apps/api:

    RUN_LIVE_PROVIDER_EVALS=1 python -m uv run pytest -m provider \
        tests/evals/test_live_scenarios.py -s

It is deselected by default (`-m "not integration and not provider"`) and skips unless
`RUN_LIVE_PROVIDER_EVALS=1`. The key is read only by the normal `Settings` mechanism (`.env` or the
environment); this file never opens a file and never prints a setting. Storage is forced to
memory for the whole process, so no database object is ever built. No retries, no appointment
confirmation and no appointment write endpoint: scenarios use an isolated in-memory world.

Output is sanitized: scenario ids, pass/fail, criteria labels, tool names, event kinds, counts,
token totals and latencies. Never a reply, a prompt, a payload or reasoning.
"""

import os
import sys

import pytest

from tests.evals.live_support import (
    OPT_IN_VARIABLE,
    PRIMARY_MODEL,
    HttpProbe,
    LogCapture,
    TokenBudget,
    decide_model,
    hard_invariant_failures,
    live_opted_in,
    run_suite,
    summarize,
)
from voice_agent_api.agent.limits import AgentLimits
from voice_agent_api.agent.providers import build_chat_model
from voice_agent_api.config import ConfigError, load_settings

pytestmark = pytest.mark.provider

# Tokens already counted, 151,528 in all: the C4 smoke, the two partial C5 runs and the run that
# scored 10 of 12 with its comparison subset (96,954 together; the second partial run's share is an
# upper bound that includes an estimate for its failed call), the 12 of 12 final attempt (47,943)
# and the real-provider browser check (6,631). The ceiling is the hard limit set for the final
# model-selection attempt; a new live run needs its own approval and ceiling.
PRIOR_TOKENS = 151_528
DAILY_CEILING = 175_000
PER_MINUTE_TARGET = 7_000


def say(line: str) -> None:
    print(line, flush=True)


@pytest.mark.skipif(
    not live_opted_in(dict(os.environ)),
    reason=f"set {OPT_IN_VARIABLE}=1 to run the live provider evaluation",
)
def test_live_agent_evaluation(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APPOINTMENT_STORE", "memory")  # no database object can be built
    try:
        settings = load_settings()
    except ConfigError:
        pytest.skip("provider configuration is incomplete (setting names are in the log)")
    if settings.agent_provider != "groq" or settings.groq_api_key is None:
        pytest.skip("the provider is not selected in the configuration")
    assert settings.appointment_store == "memory"
    api_key = settings.groq_api_key.get_secret_value()
    limits = AgentLimits.from_settings(settings)

    budget = TokenBudget(
        daily_ceiling=DAILY_CEILING, per_minute=PER_MINUTE_TARGET, already_used=PRIOR_TOKENS
    )
    reports = []
    with LogCapture() as capture:
        # The final attempt runs the primary model only; the comparison model is not run again.
        for model_name, numbers in ((PRIMARY_MODEL, tuple(range(1, 13))),):
            model = build_chat_model(settings.model_copy(update={"agent_model": model_name}))
            assert model is not None
            probe = HttpProbe()
            assert probe.attach(model), "cannot observe provider requests: refusing to run"
            say(f"--- {model_name}: scenarios {list(numbers)}")
            report = run_suite(
                model_name,
                numbers,
                model=model,
                probe=probe,
                budget=budget,
                capture=capture,
                api_key=api_key,
                limits=limits,
                announce=say,
            )
            reports.append(report)
            if report.aborted:
                break  # no retry and no second model after a provider failure

    for report in reports:
        for line in summarize(report):
            say(line)
    primary = reports[0]
    selected, reasons = decide_model(primary)
    say(f"primary selected: {selected} reasons={reasons or '-'}")
    say(f"tokens used including the earlier runs: {budget.used} of {DAILY_CEILING}")
    sys.stdout.flush()

    # Hard safety, privacy and booking invariants fail the run on every model.
    for report in reports:
        assert hard_invariant_failures(report) == [], report.model
    assert len(primary.passed) >= 11
