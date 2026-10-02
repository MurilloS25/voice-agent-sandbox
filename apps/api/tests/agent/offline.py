"""An autouse guard for offline tests: no tracing and no network beyond loopback."""

import socket
from collections.abc import Iterator
from typing import Any

import pytest

_ORIGINAL_CONNECT = socket.socket.connect
_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


@pytest.fixture(autouse=True)
def offline_guard(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    for name in (
        "LANGSMITH_TRACING",
        "LANGCHAIN_TRACING_V2",
        "LANGSMITH_API_KEY",
        "LANGCHAIN_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "false")

    def guarded(self: socket.socket, address: Any) -> None:
        host = address[0] if isinstance(address, tuple) else address
        if host not in _LOOPBACK:
            raise AssertionError("Offline test attempted a network connection.")
        return _ORIGINAL_CONNECT(self, address)

    monkeypatch.setattr(socket.socket, "connect", guarded)
    yield
