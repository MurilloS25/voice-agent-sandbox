import base64
import hmac
import json
import secrets
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest

from voice_agent_api.api.proposal_tokens import MAX_TOKEN_LENGTH, ProposalTokenCodec
from voice_agent_api.domain.errors import ProposalInvalid
from voice_agent_api.domain.models import Proposal

# Generated at run time so no key-like literal ever lands in the repository.
KEY = secrets.token_bytes(32)
CODEC = ProposalTokenCodec(KEY)
PID = UUID("12345678-1234-5678-9abc-def012345678")
FP = "9Cgz8mXx8nDhxsteH3Ko6Q"

PROPOSAL = Proposal(
    id=PID,
    service_id="flat-repair",
    start=datetime(2026, 10, 6, 14, 0, tzinfo=UTC),
    expires_at=datetime(2026, 9, 30, 12, 10, tzinfo=UTC),
    fingerprint=FP,
)


def valid_payload() -> dict[str, Any]:
    return {
        "v": 1,
        "pid": str(PID),
        "svc": "flat-repair",
        "start": "2026-10-06T14:00:00Z",
        "exp": 1790000000,
        "fp": FP,
    }


def forge(payload: object) -> str:
    """A token the server itself signed, around a payload it would never have produced."""
    return CODEC.sign_payload(payload)  # type: ignore[arg-type]


def test_round_trip() -> None:
    assert CODEC.decode(CODEC.encode(PROPOSAL)) == PROPOSAL


def test_token_carries_only_the_four_inputs_and_the_fingerprint() -> None:
    body = CODEC.encode(PROPOSAL).split(".")[1]
    payload = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
    assert set(json.loads(payload)) == {"v", "pid", "svc", "start", "exp", "fp"}


def test_a_short_key_is_rejected() -> None:
    with pytest.raises(ValueError, match="too short"):
        ProposalTokenCodec(b"short")


def test_a_different_key_cannot_verify() -> None:
    other = ProposalTokenCodec(secrets.token_bytes(32))
    with pytest.raises(ProposalInvalid):
        other.decode(CODEC.encode(PROPOSAL))


def test_tampering_with_the_payload_breaks_the_signature() -> None:
    prefix, body, signature = CODEC.encode(PROPOSAL).split(".")
    flipped = ("A" if body[10] != "A" else "B").join([body[:10], body[11:]])
    with pytest.raises(ProposalInvalid):
        CODEC.decode(f"{prefix}.{flipped}.{signature}")


def test_tampering_with_the_signature_is_rejected() -> None:
    prefix, body, signature = CODEC.encode(PROPOSAL).split(".")
    flipped = ("A" if signature[0] != "A" else "B") + signature[1:]
    with pytest.raises(ProposalInvalid):
        CODEC.decode(f"{prefix}.{body}.{flipped}")


@pytest.mark.parametrize("token", ["", "v1", "v1.a", "v1.a.b.c", "v2.a.b", ".a.b", "v1..", "x"])
def test_malformed_tokens_are_rejected(token: str) -> None:
    with pytest.raises(ProposalInvalid):
        CODEC.decode(token)


def test_over_long_and_non_ascii_tokens_are_rejected() -> None:
    with pytest.raises(ProposalInvalid):
        CODEC.decode("v1." + "a" * MAX_TOKEN_LENGTH + ".b")
    with pytest.raises(ProposalInvalid):
        CODEC.decode("v1.é.b")


def test_non_canonical_base64_is_rejected() -> None:
    prefix, body, signature = CODEC.encode(PROPOSAL).split(".")
    with pytest.raises(ProposalInvalid):
        CODEC.decode(f"{prefix}.{body}=.{signature}")


@pytest.mark.parametrize(
    "extra", ["end", "biz", "alias", "bench", "duration", "price", "service", "business_id"]
)
def test_signed_payloads_with_derived_fields_are_rejected(extra: str) -> None:
    payload = valid_payload() | {extra: "anything"}
    with pytest.raises(ProposalInvalid):
        CODEC.decode(forge(payload))


@pytest.mark.parametrize("missing", ["v", "pid", "svc", "start", "exp", "fp"])
def test_signed_payloads_missing_a_field_are_rejected(missing: str) -> None:
    payload = valid_payload()
    del payload[missing]
    with pytest.raises(ProposalInvalid):
        CODEC.decode(forge(payload))


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("v", 2),
        ("v", "1"),
        ("v", True),
        ("pid", "not-a-uuid"),
        ("pid", str(PID).upper()),
        ("pid", PID.hex),
        ("pid", 5),
        ("svc", "Flat Repair"),
        ("svc", "../etc"),
        ("svc", ""),
        ("svc", "x" * 65),
        ("start", "2026-10-06T14:00:00"),
        ("start", "2026-10-06T14:00:00+00:00"),
        ("start", "2026-10-06 14:00:00Z"),
        ("start", "2026-10-06T14:00:00.5Z"),
        ("start", "2026-13-06T14:00:00Z"),
        ("start", 1790000000),
        ("exp", "1790000000"),
        ("exp", True),
        ("exp", -5),
        ("exp", 0),
        ("exp", 1.5),
        ("exp", 10**20),
        ("fp", "short"),
        ("fp", "A" * 23),
        ("fp", "A" * 21 + "!"),
        ("fp", 5),
    ],
)
def test_signed_payloads_with_malformed_values_are_rejected(field: str, value: object) -> None:
    payload = valid_payload() | {field: value}
    with pytest.raises(ProposalInvalid):
        CODEC.decode(forge(payload))


@pytest.mark.parametrize("payload", [[], "text", 5, None, [valid_payload()]])
def test_signed_payloads_that_are_not_objects_are_rejected(payload: object) -> None:
    with pytest.raises(ProposalInvalid):
        CODEC.decode(forge(payload))


def test_a_well_formed_but_wrong_fingerprint_parses() -> None:
    # The fingerprint is only compared later. A forged one is "stale", not "invalid".
    decoded = CODEC.decode(forge(valid_payload() | {"fp": "B" * 22}))
    assert decoded.fingerprint == "B" * 22
    assert decoded.id == PID


def test_signature_is_compared_in_constant_time(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[int] = []
    real = hmac.compare_digest

    def spy(a: bytes, b: bytes) -> bool:
        calls.append(1)
        return bool(real(a, b))

    monkeypatch.setattr(hmac, "compare_digest", spy)
    CODEC.decode(CODEC.encode(PROPOSAL))
    assert calls
