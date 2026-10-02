"""The `HH:MM` tool arguments, as the provider sees them and as the server validates them.

A live run was rejected by the provider (HTTP 400) after the schema published `format: "time"`
for these arguments: that format means `HH:MM:SS`, while the tool, the prompt and the events use
`HH:MM`. These tests pin the published schema and prove it agrees with the server's validation.
"""

import json
import re
from datetime import time
from typing import Any

import pytest
from pydantic import ValidationError

from voice_agent_api.agent.tools import (
    CLOCK_TIME_PATTERN,
    FindAvailableSlotsArgs,
    parse_tool_args,
    tool_input_for_event,
    tool_specs,
)

BASE = {"service_id": "flat-repair", "date": "2026-10-06"}
TIME_FIELDS = ("earliest_local_time", "latest_local_time")


def find_schema() -> dict[str, Any]:
    spec = next(s for s in tool_specs() if s["function"]["name"] == "find_available_slots")
    schema: dict[str, Any] = spec["function"]["parameters"]
    return schema


def contains_time_format(node: Any) -> bool:
    if isinstance(node, dict):
        return node.get("format") == "time" or any(contains_time_format(v) for v in node.values())
    if isinstance(node, list):
        return any(contains_time_format(v) for v in node)
    return False


# -- the published schema -------------------------------------------------------------------------


@pytest.mark.parametrize("field", TIME_FIELDS)
def test_the_provider_sees_a_string_with_the_hh_mm_pattern(field: str) -> None:
    prop = find_schema()["properties"][field]
    string_branch = next(b for b in prop["anyOf"] if b.get("type") == "string")
    assert string_branch == {"type": "string", "pattern": r"^([01]\d|2[0-3]):[0-5]\d$"}
    assert {"type": "null"} in prop["anyOf"]  # the argument stays optional
    assert "format" not in string_branch


def test_no_tool_schema_publishes_format_time() -> None:
    assert not contains_time_format(tool_specs())
    assert not contains_time_format(FindAvailableSlotsArgs.model_json_schema())
    assert '"format": "time"' not in json.dumps(tool_specs())


def test_the_pattern_is_the_single_source_for_validation_and_the_schema() -> None:
    assert CLOCK_TIME_PATTERN == r"^([01]\d|2[0-3]):[0-5]\d$"
    for field in TIME_FIELDS:
        branches = find_schema()["properties"][field]["anyOf"]
        assert any(b.get("pattern") == CLOCK_TIME_PATTERN for b in branches)


def test_the_date_argument_is_unchanged() -> None:
    date = find_schema()["properties"]["date"]
    assert (date["type"], date["format"]) == ("string", "date")


def test_the_schema_keeps_the_rest_of_the_tool_contract() -> None:
    schema = find_schema()
    assert schema["additionalProperties"] is False
    assert sorted(schema["properties"]) == [
        "date",
        "days",
        "earliest_local_time",
        "latest_local_time",
        "service_id",
    ]
    assert schema["required"] == ["service_id", "date"]


# -- the server's validation ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "parsed"),
    [
        ("12:00", time(12, 0)),
        ("00:00", time(0, 0)),
        ("23:59", time(23, 59)),
        ("09:30", time(9, 30)),
    ],
)
def test_hh_mm_is_accepted_and_stays_a_time_internally(raw: str, parsed: time) -> None:
    for field in TIME_FIELDS:
        args = parse_tool_args("find_available_slots", {**BASE, field: raw})
        assert getattr(args, field) == parsed
        assert isinstance(getattr(args, field), time)


@pytest.mark.parametrize(
    "raw",
    [
        "12:00:00",
        "24:00",
        "9:00",
        "09:5",
        "12.00",
        "1200",
        "12:60",
        "",
        " 12:00",
        "12:00 ",
        "12:00\n",
        "ab:cd",
    ],
)
def test_anything_else_is_rejected(raw: str) -> None:
    for field in TIME_FIELDS:
        with pytest.raises(ValidationError):
            parse_tool_args("find_available_slots", {**BASE, field: raw})


@pytest.mark.parametrize("raw", [1200, 12.0, True, ["12:00"], {"h": 12}, time(12, 0)])
def test_non_strings_are_rejected(raw: object) -> None:
    for field in TIME_FIELDS:
        with pytest.raises(ValidationError):
            parse_tool_args("find_available_slots", {**BASE, field: raw})


def test_the_schema_pattern_and_the_validator_agree_on_every_hour_and_minute() -> None:
    pattern = re.compile(CLOCK_TIME_PATTERN)
    candidates = [f"{h:02d}:{m:02d}" for h in range(0, 26) for m in range(0, 62)]
    candidates += ["9:00", "12:00:00", "24:00", "7:5", "12:0", "123:00"]
    for text in candidates:
        accepted = True
        try:
            parse_tool_args("find_available_slots", {**BASE, "earliest_local_time": text})
        except ValidationError:
            accepted = False
        assert accepted == bool(pattern.fullmatch(text)), text


def test_events_still_show_hh_mm() -> None:
    args = parse_tool_args(
        "find_available_slots",
        {**BASE, "earliest_local_time": "12:00", "latest_local_time": "17:30"},
    )
    shown = tool_input_for_event(args)
    assert (shown.earliest_local_time, shown.latest_local_time) == ("12:00", "17:30")


def test_the_two_bounds_are_independent_and_optional() -> None:
    args = parse_tool_args("find_available_slots", BASE)
    assert (args.earliest_local_time, args.latest_local_time) == (None, None)  # type: ignore[attr-defined]
