"""The privacy taxonomy for agent traffic, as an executable audit.

Four surfaces, three kinds of identifier:

- **Public surfaces**: the timeline events, the reply text and the logs. They may hold none of
  the identifiers below.
- **The private provider protocol**: the messages sent to the model provider. A provider-generated
  `tool_call_id` (possibly UUID-shaped) is *allowed* here, in the two id fields that pair a tool
  result with its tool call (`tool_calls[].id` and `tool_call_id`), and nowhere else: the next
  request needs it to correlate, nothing more.
- **Application and domain identifiers** (conversation id, client turn id, proposal id,
  appointment id, bench or database ids) are forbidden on every surface above, provider traffic
  and tool-call arguments included. The proposal token is forbidden there too: it exists only in
  `booking_review` and the confirm form's hidden field, which are not part of these surfaces.

Values are matched as real strings (JSON is decoded first), so quotes, newlines and non-ASCII
characters cannot hide a leak. A failed audit reports only the surface and the *type* of
identifier, never the matched value.
"""

import copy
import json
import re
from collections.abc import Collection, Iterator, Mapping, Sequence
from typing import Any, NamedTuple

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage

UUID_SHAPE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
TOKEN_SHAPE = re.compile(r"v1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")
REASONING_KEYS = ("reasoning", "reasoning_content")
PUBLIC_SOURCES = ("events", "reply", "logs")
_PLACEHOLDER = "<provider-correlation-id>"
_MIN_CORRELATION_ID_LENGTH = 6
# A very short reasoning string ("OK.") would match unrelated text, so shorter ones are not matched.
_MIN_REASONING_LENGTH = 20


class Violation(NamedTuple):
    """Where something was found and what type it was: never its value."""

    source: str  # events | reply | logs | provider
    kind: str  # e.g. proposal_token, conversation_id, provider_tool_call_id, api_key, reasoning


def messages_from_langchain(messages: Sequence[BaseMessage]) -> list[dict[str, Any]]:
    """The OpenAI wire shape of what a provider receives, tool-call arguments included."""
    converted: list[dict[str, Any]] = []
    for message in messages:
        entry: dict[str, Any] = {"role": message.type, "content": str(message.content)}
        if isinstance(message, AIMessage):
            calls = [
                {
                    "id": call.get("id"),
                    "type": "function",
                    "function": {
                        "name": call["name"],
                        "arguments": json.dumps(call["args"], sort_keys=True),
                    },
                }
                for call in message.tool_calls
            ] + [
                {
                    "id": call.get("id"),
                    "type": "function",
                    "function": {"name": call.get("name"), "arguments": call.get("args")},
                }
                for call in message.invalid_tool_calls
            ]
            if calls:
                entry["tool_calls"] = calls
            for key in REASONING_KEYS:
                if key in message.additional_kwargs:
                    entry[key] = message.additional_kwargs[key]
        if isinstance(message, ToolMessage):
            entry["tool_call_id"] = message.tool_call_id
            entry["name"] = message.name
        converted.append(entry)
    return converted


def _usable(correlation_id: object) -> bool:
    return isinstance(correlation_id, str) and len(correlation_id) >= _MIN_CORRELATION_ID_LENGTH


def correlation_ids(messages: Sequence[Mapping[str, Any]]) -> set[str]:
    """Provider-generated ids that pair tool results with tool calls."""
    found: set[str] = set()
    for message in messages:
        if _usable(message.get("tool_call_id")):
            found.add(str(message["tool_call_id"]))
        for call in message.get("tool_calls") or []:
            if _usable(call.get("id")):
                found.add(str(call["id"]))
    return found


def _scrub_correlation(messages: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The messages with the correlation-id *fields* masked: the only place such an id may be."""
    scrubbed = copy.deepcopy([dict(m) for m in messages])
    for message in scrubbed:
        if _usable(message.get("tool_call_id")):
            message["tool_call_id"] = _PLACEHOLDER
        for call in message.get("tool_calls") or []:
            if _usable(call.get("id")):
                call["id"] = _PLACEHOLDER
    return scrubbed


def _walk(value: Any) -> Iterator[tuple[str | None, str]]:
    """Every string leaf with the key it sits under, and every key as its own entry."""
    if isinstance(value, Mapping):
        for key, item in value.items():
            yield (str(key), "")
            for _, leaf in _walk(item):
                yield (str(key), leaf)
    elif isinstance(value, list | tuple):
        for item in value:
            yield from _walk(item)
    elif isinstance(value, str):
        yield (None, value)
    elif value is not None:
        yield (None, str(value))


def _decoded(text: str) -> list[str]:
    """The raw text plus, when it is JSON, every string inside it (unescaped), recursively. Also
    decodes JSON strings embedded in JSON, such as tool-call `arguments`."""
    pieces = [text]
    try:
        loaded = json.loads(text)
    except (ValueError, TypeError):
        return pieces
    for _, leaf in _walk(loaded):
        if leaf:
            pieces.append(leaf)
            if leaf[:1] in "{[":
                pieces.extend(_decoded(leaf)[1:])
    return pieces


def _has_reasoning_key(value: Any) -> bool:
    if isinstance(value, Mapping):
        return any(key in REASONING_KEYS or _has_reasoning_key(item) for key, item in value.items())
    if isinstance(value, list | tuple):
        return any(_has_reasoning_key(item) for item in value)
    return False


def _contains_id(pieces: Sequence[str], identifier: str) -> bool:
    """Whole-token containment: `call_1` is not found inside `call_10`."""
    pattern = re.compile(rf"(?<![A-Za-z0-9_-]){re.escape(identifier)}(?![A-Za-z0-9_-])")
    return any(pattern.search(piece) for piece in pieces)


def audit(
    *,
    events_text: str,
    reply_text: str,
    logs_text: str,
    provider_messages: Sequence[Mapping[str, Any]],
    forbidden_ids: Mapping[str, Collection[str]] | None = None,
    reasoning_texts: Collection[str] = (),
    api_key: str = "",
) -> list[Violation]:
    """Check every surface. An empty list means the taxonomy holds."""
    forbidden = forbidden_ids or {}
    correlation = correlation_ids(provider_messages)
    scrubbed = _scrub_correlation(provider_messages)
    provider_pieces = _decoded(json.dumps(scrubbed)) + [leaf for _, leaf in _walk(scrubbed)]
    surfaces: dict[str, list[str]] = {
        "events": _decoded(events_text),
        "reply": _decoded(reply_text),
        "logs": _decoded(logs_text),
        "provider": provider_pieces,
    }
    found: list[Violation] = []

    def flag(source: str, kind: str) -> None:
        violation = Violation(source, kind)
        if violation not in found:
            found.append(violation)

    for source, pieces in surfaces.items():
        joined = "\n".join(pieces)
        if TOKEN_SHAPE.search(joined):
            flag(source, "proposal_token")
        for kind, values in forbidden.items():
            if any(value and value in joined for value in values):
                flag(source, kind)
        if UUID_SHAPE.search(joined):
            # Public surfaces hold no UUID-shaped id at all. In provider traffic the only allowed
            # one is a correlation id in its two fields, which were masked above.
            flag(source, "uuid_shaped_identifier")
        if api_key and api_key in joined:
            flag(source, "api_key")
        if any(len(r) >= _MIN_REASONING_LENGTH and r in joined for r in reasoning_texts):
            flag(source, "reasoning")
        # A correlation id anywhere but its protocol fields is a leak: on a public surface, or in
        # provider content or arguments (the masked copy no longer holds it in its fields).
        if any(_contains_id(pieces, cid) for cid in correlation):
            flag(source, "provider_tool_call_id")

    if _has_reasoning_key(list(provider_messages)):
        flag("provider", "reasoning_field")
    return found


def describe(violations: Sequence[Violation]) -> str:
    """A report that is safe to print: sources and identifier types only."""
    return ", ".join(f"{v.source}:{v.kind}" for v in violations) or "none"
