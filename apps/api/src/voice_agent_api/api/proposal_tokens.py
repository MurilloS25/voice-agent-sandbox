"""Signed, short-lived proposal tokens: `v1.<payload>.<signature>`.

The payload is exactly `{v, pid, svc, start, exp, fp}`. Nothing derived is carried: no end time,
business, alias, bench, duration or price. The signature is verified (constant time) before the
payload is parsed, and parsing is strict, so unknown keys or odd types are rejected.
"""

import base64
import binascii
import hashlib
import hmac
import json
import re
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from voice_agent_api.config import MIN_SIGNING_KEY_BYTES
from voice_agent_api.domain.errors import ProposalInvalid
from voice_agent_api.domain.models import Proposal

_PREFIX = "v1"
_PAYLOAD_KEYS = frozenset({"v", "pid", "svc", "start", "exp", "fp"})
_START = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
_SERVICE_ID = re.compile(r"[a-z0-9-]{1,64}")
_FINGERPRINT = re.compile(r"[A-Za-z0-9_-]{22}")
MAX_TOKEN_LENGTH = 2048


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(text: str) -> bytes:
    try:
        raw = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError):
        raise ProposalInvalid from None
    if _b64e(raw) != text:  # reject non-canonical encodings
        raise ProposalInvalid
    return raw


class ProposalTokenCodec:
    def __init__(self, key: bytes) -> None:
        if len(key) < MIN_SIGNING_KEY_BYTES:
            raise ValueError("The signing key is too short.")
        self._key = key

    def _sign(self, signed_part: str) -> bytes:
        return hmac.new(self._key, signed_part.encode("ascii"), hashlib.sha256).digest()

    def sign_payload(self, payload: dict[str, Any]) -> str:
        """Sign an arbitrary payload dict. `encode` uses it; tests use it to forge inputs."""
        body = _b64e(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())
        signed_part = f"{_PREFIX}.{body}"
        return f"{signed_part}.{_b64e(self._sign(signed_part))}"

    def encode(self, proposal: Proposal) -> str:
        return self.sign_payload(
            {
                "v": 1,
                "pid": str(proposal.id),
                "svc": proposal.service_id,
                "start": proposal.start.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "exp": int(proposal.expires_at.timestamp()),
                "fp": proposal.fingerprint,
            }
        )

    def decode(self, token: str) -> Proposal:
        """Verify and parse a token. Raises `ProposalInvalid` for anything wrong."""
        if len(token) > MAX_TOKEN_LENGTH or not token.isascii():
            raise ProposalInvalid
        parts = token.split(".")
        if len(parts) != 3 or parts[0] != _PREFIX:
            raise ProposalInvalid
        signature = _b64d(parts[2])
        if not hmac.compare_digest(signature, self._sign(f"{parts[0]}.{parts[1]}")):
            raise ProposalInvalid

        try:
            payload = json.loads(_b64d(parts[1]))
        except (ValueError, UnicodeDecodeError):
            raise ProposalInvalid from None
        return _parse_payload(payload)


def _parse_payload(payload: object) -> Proposal:
    if not isinstance(payload, dict) or set(payload) != _PAYLOAD_KEYS:
        raise ProposalInvalid
    version, pid, svc = payload["v"], payload["pid"], payload["svc"]
    start, exp, fingerprint = payload["start"], payload["exp"], payload["fp"]

    if type(version) is not int or version != 1:
        raise ProposalInvalid
    if type(exp) is not int or exp <= 0:
        raise ProposalInvalid
    if not (isinstance(pid, str) and isinstance(svc, str) and isinstance(start, str)):
        raise ProposalInvalid
    if not isinstance(fingerprint, str):
        raise ProposalInvalid
    if not _SERVICE_ID.fullmatch(svc) or not _FINGERPRINT.fullmatch(fingerprint):
        raise ProposalInvalid
    if not _START.fullmatch(start):
        raise ProposalInvalid
    try:
        proposal_id = UUID(pid)
        start_at = datetime.strptime(start, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
        expires_at = datetime.fromtimestamp(exp, tz=UTC)
    except (ValueError, OverflowError, OSError):
        raise ProposalInvalid from None
    if str(proposal_id) != pid:
        raise ProposalInvalid
    return Proposal(
        id=proposal_id,
        service_id=svc,
        start=start_at,
        expires_at=expires_at,
        fingerprint=fingerprint,
    )
