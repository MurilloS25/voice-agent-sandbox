"""One ASGI layer in front of every route: authentication, a draining check, rate limits, a bound
on JSON bodies, and a last-resort handler for errors nothing else caught.

It runs before FastAPI parses anything and before any provider is called. It is pure ASGI (not
`BaseHTTPMiddleware`) so it never buffers a streamed body it does not need to read, and it logs
only outcome codes and category names: never a client id, a path with identifiers, a header value
or an exception's text.
"""

import asyncio
import json
import logging
import re
import secrets
from collections.abc import Awaitable, Callable, MutableMapping
from dataclasses import dataclass
from typing import Any

from voice_agent_api.security.auth import is_authorized
from voice_agent_api.security.ratelimit import Category, RateLimits

logger = logging.getLogger("voice_agent_api")

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

UNATTRIBUTED = "unattributed"
CLIENT_ID_HEADER = b"x-client-id"
_CLIENT_ID = re.compile(r"[0-9a-f]{32}")

# Reachable without credentials: Render's health check cannot send a header, and the web tier
# polls readiness while the API wakes. Both answer with a status word and nothing else.
PUBLIC_PATHS = frozenset({"/health", "/health/live", "/health/ready"})

_ROUTES: tuple[tuple[str, re.Pattern[str], Category], ...] = (
    ("POST", re.compile(r"/v1/agent/turns"), Category.AGENT),
    ("POST", re.compile(r"/v1/speech/transcriptions"), Category.SPEECH),
    ("POST", re.compile(r"/v1/appointment-proposals"), Category.WRITE),
    ("POST", re.compile(r"/v1/appointments"), Category.WRITE),
    ("GET", re.compile(r"/v1/business"), Category.READ),
    ("GET", re.compile(r"/v1/services"), Category.READ),
    ("GET", re.compile(r"/v1/services/[^/]+/availability"), Category.READ),
    ("GET", re.compile(r"/v1/appointments/[^/]+"), Category.READ),
)

# Routes whose body is small JSON that the middleware reads (bounded) before FastAPI does. The
# audio route reads its own stream incrementally and has its own limit.
_JSON_CATEGORIES = frozenset({Category.AGENT, Category.WRITE})
# Costly categories: refused while the process is shutting down.
_COSTLY = frozenset({Category.AGENT, Category.SPEECH})


def categorize(method: str, path: str) -> Category | None:
    for route_method, pattern, category in _ROUTES:
        if method == route_method and pattern.fullmatch(path):
            return category
    return None


def parse_client_id(value: bytes | None) -> str:
    """A client id the web tier computed (a keyed hash, hex), or the shared `unattributed` key.

    The value is trusted only because the request already authenticated; anything malformed is
    treated as unattributed, which shares one (strict) bucket instead of opening a new one."""
    if value is None:
        return UNATTRIBUTED
    try:
        text = value.decode("ascii")
    except UnicodeDecodeError:
        return UNATTRIBUTED
    return text if _CLIENT_ID.fullmatch(text) else UNATTRIBUTED


@dataclass(frozen=True)
class Protection:
    """What the layer enforces. `secret_digest` None means authentication is off (development and
    test only: configuration refuses that in production)."""

    secret_digest: bytes | None
    limits: RateLimits | None
    json_body_limit: int = 16 * 1024
    json_read_timeout_s: float = 5.0


def _error(status: int, code: str, message: str, headers: dict[str, str] | None = None) -> bytes:
    return json.dumps({"error": {"code": code, "message": message}}).encode("utf-8")


async def _respond(
    send: Send, status: int, code: str, message: str, headers: dict[str, str] | None = None
) -> None:
    body = _error(status, code, message)
    raw_headers = [
        (b"content-type", b"application/json"),
        (b"content-length", str(len(body)).encode("ascii")),
        (b"cache-control", b"no-store"),
    ]
    for name, value in (headers or {}).items():
        raw_headers.append((name.lower().encode("ascii"), value.encode("ascii")))
    await send({"type": "http.response.start", "status": status, "headers": raw_headers})
    await send({"type": "http.response.body", "body": body})


def _header(scope: Scope, name: bytes) -> bytes | None:
    for key, value in scope.get("headers", ()):
        if key == name:
            return bytes(value)
    return None


class ProtectionMiddleware:
    def __init__(self, app: ASGIApp, protection: Protection) -> None:
        self.app = app
        self.protection = protection

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        method = str(scope["method"])
        path = str(scope["path"])

        if method in ("GET", "HEAD") and path in PUBLIC_PATHS:
            await self._guarded(scope, receive, send)
            return

        # 1. Who is calling. A generic answer: it never says which part was missing or wrong.
        digest = self.protection.secret_digest
        if digest is not None:
            authorization = _header(scope, b"authorization")
            header = authorization.decode("latin-1") if authorization is not None else None
            if not is_authorized(digest, header):
                logger.info("request_rejected reason=unauthorized")
                await _respond(send, 401, "unauthorized", "Authentication is required.")
                return

        category = categorize(method, path)

        # 2. Draining: a costly request is refused before it starts.
        app = scope.get("app")
        if category in _COSTLY and getattr(getattr(app, "state", None), "draining", False):
            logger.info("request_rejected reason=draining category=%s", category)
            await _respond(
                send,
                503,
                "service_draining",
                "The service is restarting. Try again in a moment.",
                {"Retry-After": "5"},
            )
            return

        # 3. How often. Before any body is read and before any provider is called.
        if category is not None and self.protection.limits is not None:
            client = parse_client_id(_header(scope, CLIENT_ID_HEADER))
            wait = self.protection.limits.check(category, client)
            if wait is not None:
                logger.info("request_rejected reason=rate_limited category=%s", category)
                await _respond(
                    send,
                    429,
                    "rate_limited",
                    "Too many requests. Try again shortly.",
                    {"Retry-After": str(wait)},
                )
                return

        # 4. How big. Small JSON bodies are read here, bounded, and handed on unchanged.
        if category in _JSON_CATEGORIES and method == "POST":
            buffered = await self._read_json_body(scope, receive, send)
            if buffered is None:
                return
            receive = buffered
        await self._guarded(scope, receive, send)

    async def _read_json_body(self, scope: Scope, receive: Receive, send: Send) -> Receive | None:
        limit = self.protection.json_body_limit
        declared = _header(scope, b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > limit:
            logger.info("request_rejected reason=body_too_large")
            await _respond(send, 413, "body_too_large", "That request is too large.")
            return None
        chunks: list[bytes] = []
        total = 0

        async def read_all() -> bool:
            nonlocal total
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return False
                body = bytes(message.get("body", b""))
                total += len(body)
                if total > limit:
                    return False
                chunks.append(body)
                if not message.get("more_body", False):
                    return True

        try:
            complete = await asyncio.wait_for(read_all(), self.protection.json_read_timeout_s)
        except TimeoutError:
            logger.info("request_rejected reason=body_timeout")
            await _respond(send, 408, "request_timeout", "The request took too long to arrive.")
            return None
        if not complete:
            if total > limit:
                logger.info("request_rejected reason=body_too_large")
                await _respond(send, 413, "body_too_large", "That request is too large.")
            return None

        replay = [b"".join(chunks)]

        async def replayed() -> Message:
            if replay:
                return {"type": "http.request", "body": replay.pop(), "more_body": False}
            return {"type": "http.disconnect"}

        return replayed

    async def _guarded(self, scope: Scope, receive: Receive, send: Send) -> None:
        """The app, with a last-resort handler: whatever escapes becomes a generic 500 and one
        log line (a random correlation id and the exception's class, never its text)."""
        started = False

        async def tracking(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, tracking)
        except Exception as exc:
            correlation = secrets.token_hex(4)
            route = getattr(scope.get("route"), "path", "-")
            app = scope.get("app")
            verbose = bool(getattr(getattr(app, "state", None), "log_tracebacks", False))
            logger.error(
                "unhandled_error route=%s error=%s correlation=%s",
                route,
                type(exc).__name__,
                correlation,
                exc_info=exc if verbose else None,
            )
            if not started:
                await _respond(
                    send,
                    500,
                    "internal_error",
                    "Something went wrong.",
                    {"X-Correlation-Id": correlation},
                )
