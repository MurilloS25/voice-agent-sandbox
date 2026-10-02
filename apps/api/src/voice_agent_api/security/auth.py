"""Server-to-server authentication: a shared secret presented as a bearer token.

The browser never calls the API, so this is not user authentication. It keeps anyone who learns
the API's address from spending the provider budget or reaching the booking routes directly.

The comparison is constant time: both sides are hashed to the same length first, so neither the
secret's length nor the position of the first differing byte shows in the timing. The secret is
only ever read from the `Authorization` header: never from a query parameter, a cookie or a body.
"""

import hashlib
import hmac

MIN_SECRET_CHARS = 32


def secret_digest(secret: str) -> bytes:
    """The fixed-length value the API keeps instead of the secret itself."""
    return hashlib.sha256(secret.encode("utf-8")).digest()


def bearer_token(header: str | None) -> str | None:
    """The token of a well-formed `Authorization: Bearer <token>` header, otherwise None."""
    if header is None:
        return None
    scheme, separator, token = header.partition(" ")
    if separator != " " or scheme.lower() != "bearer" or not token or " " in token:
        return None
    return token


def is_authorized(expected_digest: bytes, header: str | None) -> bool:
    """True only when the header carries exactly the secret. Never raises."""
    token = bearer_token(header)
    # Hash even a missing token, so a request without credentials takes the same path.
    presented = secret_digest(token if token is not None else "")
    matches = hmac.compare_digest(presented, expected_digest)
    return matches and token is not None
