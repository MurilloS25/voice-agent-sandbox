"""The Postgres adapter is synchronous, so nothing that reaches a port may run on the event loop.

These tests use an artificially slow, blocking appointment book as a stand-in for the database.
"""

import ast
import asyncio
import inspect
import secrets
import threading
import time
from collections.abc import Sequence
from datetime import date, datetime
from pathlib import Path
from uuid import UUID

import httpx
from fastapi import FastAPI
from fastapi.routing import APIRoute

from tests.support import NOW, SLOT_START, make_world
from voice_agent_api.api.proposal_tokens import ProposalTokenCodec
from voice_agent_api.api.routes import router
from voice_agent_api.domain.commands import propose_appointment
from voice_agent_api.domain.models import (
    Appointment,
    Booking,
    CatalogSnapshot,
    Money,
    Proposal,
)
from voice_agent_api.domain.ports import BusinessCatalog, Decide
from voice_agent_api.factory import create_app

KEY = secrets.token_bytes(32)
DELAY = 0.3
SRC = Path(__file__).resolve().parents[2] / "src" / "voice_agent_api"


class SlowBook:
    """Blocks its calling thread, like a synchronous database call would."""

    def __init__(self, catalog: BusinessCatalog) -> None:
        self.catalog = catalog
        self.threads: set[int] = set()

    def day_view(
        self, service_id: str, when: date | datetime
    ) -> tuple[CatalogSnapshot, Sequence[Booking]]:
        return self.catalog.snapshot(service_id), ()

    def bookings_overlapping(self, start: datetime, end: datetime) -> Sequence[Booking]:
        return ()

    def confirm(self, proposal: Proposal, decide: Decide) -> tuple[Appointment, bool]:
        self.threads.add(threading.get_ident())
        time.sleep(DELAY)
        return (
            Appointment(
                id=proposal.id,
                business_id="test",
                service_id=proposal.service_id,
                bench=1,
                start=proposal.start,
                end=proposal.start,
                status="confirmed",
                customer_alias="Demo Slow Book",
                source="web_demo",
                proposal_id=proposal.id,
                created_at=NOW,
                updated_at=NOW,
                service_name="Flat repair",
                price=Money(1500, "USD"),
                timezone="America/New_York",
            ),
            True,
        )

    def get(self, appointment_id: UUID) -> Appointment | None:
        return None


def build() -> tuple[FastAPI, SlowBook, str]:
    catalog, _ = make_world()
    book = SlowBook(catalog)
    app = create_app(catalog, book, lambda: NOW, signing_key=KEY)
    review = propose_appointment(book, "flat-repair", SLOT_START, NOW, lambda: UUID(int=1))
    return app, book, ProposalTokenCodec(KEY).encode(review.proposal)


async def lag_sampler(stop: asyncio.Event, lags: list[float]) -> None:
    """Records how late a 10 ms sleep wakes up: the event loop's responsiveness."""
    loop = asyncio.get_running_loop()
    previous = loop.time()
    while not stop.is_set():
        await asyncio.sleep(0.01)
        now = loop.time()
        lags.append(now - previous - 0.01)
        previous = now


async def measure(
    app: FastAPI, requests: int, path: str, **post_kwargs: object
) -> tuple[float, float, float]:
    """Fire concurrent POSTs plus a /health probe. Returns (elapsed, health_latency, max_lag)."""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        stop, lags = asyncio.Event(), list[float]()
        sampler = asyncio.create_task(lag_sampler(stop, lags))
        await asyncio.sleep(0.05)

        started = time.perf_counter()
        posts = [asyncio.create_task(client.post(path, **post_kwargs)) for _ in range(requests)]  # type: ignore[arg-type]
        await asyncio.sleep(0.05)  # let the handlers start blocking
        probe_started = time.perf_counter()
        health = await client.get("/health")
        health_latency = time.perf_counter() - probe_started
        assert health.status_code == 200
        await asyncio.gather(*posts)
        elapsed = time.perf_counter() - started

        stop.set()
        await sampler
        return elapsed, health_latency, max(lags)


def test_concurrent_confirms_are_not_serialized_by_a_blocked_event_loop() -> None:
    app, book, token = build()
    elapsed, health_latency, max_lag = asyncio.run(
        measure(app, 8, "/v1/appointments", json={"proposal_token": token, "confirm": True})
    )

    assert len(book.threads) > 1  # ran in the worker threadpool, in parallel
    assert elapsed < 1.0, f"8 x {DELAY}s took {elapsed:.2f}s: requests were serialized"
    assert health_latency < 0.1, f"/health took {health_latency:.3f}s while confirms ran"
    assert max_lag < 0.1, f"the event loop stalled for {max_lag:.3f}s"


def test_the_detector_notices_a_route_that_blocks_the_event_loop() -> None:
    app, _, _ = build()

    @app.get("/blocking")
    async def blocking() -> dict[str, bool]:  # a deliberate bug, to prove the harness works
        time.sleep(DELAY)
        return {"ok": True}

    async def run() -> float:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            stop, lags = asyncio.Event(), list[float]()
            sampler = asyncio.create_task(lag_sampler(stop, lags))
            await asyncio.sleep(0.05)
            await client.get("/blocking")
            stop.set()
            await sampler
            return max(lags)

    assert asyncio.run(run()) > 0.25


def _api_routes() -> list[APIRoute]:
    # The app wraps included routers, so read the routes from the router itself.
    return [r for r in router.routes if isinstance(r, APIRoute)]


def test_every_route_and_dependency_that_reaches_a_port_is_a_plain_def() -> None:
    routes = [r for r in _api_routes() if r.path.startswith("/v1")]
    assert len(routes) >= 6

    def walk(dependant: object) -> list[object]:
        calls = [getattr(dependant, "call", None)]
        for child in getattr(dependant, "dependencies", []):
            calls.extend(walk(child))
        return calls

    for route in routes:
        for call in walk(route.dependant):
            assert call is None or not inspect.iscoroutinefunction(call), (
                f"{route.path}: {call!r} would run on the event loop"
            )


def test_route_and_dependency_modules_define_no_async_functions() -> None:
    for name in ("api/routes.py", "api/dependencies.py", "infrastructure/postgres.py"):
        tree = ast.parse((SRC / name).read_text(encoding="utf-8"))
        offenders = [n.name for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef)]
        assert not offenders, f"{name} defines async functions: {offenders}"


def test_lifespan_opens_and_closes_resources_off_the_event_loop() -> None:
    catalog, book = make_world()
    seen: dict[str, int] = {}

    class Resource:
        def open(self) -> None:
            seen["open"] = threading.get_ident()

        def close(self) -> None:
            seen["close"] = threading.get_ident()

    app = create_app(catalog, book, lambda: NOW, signing_key=KEY, resources=(Resource(),))

    async def run() -> int:
        loop_thread = threading.get_ident()
        async with app.router.lifespan_context(app):
            assert "open" in seen
        return loop_thread

    loop_thread = asyncio.run(run())
    assert seen["open"] != loop_thread
    assert seen["close"] != loop_thread


def test_a_failing_open_still_closes_what_was_opened_and_aborts_startup() -> None:
    catalog, book = make_world()
    events: list[str] = []

    class Good:
        def open(self) -> None:
            events.append("good-open")

        def close(self) -> None:
            events.append("good-close")

    class Bad:
        def open(self) -> None:
            raise RuntimeError("boom")

        def close(self) -> None:
            events.append("bad-close")

    app = create_app(catalog, book, lambda: NOW, signing_key=KEY, resources=(Good(), Bad()))

    async def run() -> None:
        async with app.router.lifespan_context(app):
            raise AssertionError("startup should have failed")

    try:
        asyncio.run(run())
    except RuntimeError as exc:
        assert str(exc) == "boom"
    assert events == ["good-open", "good-close"]  # the one that never opened is not closed
