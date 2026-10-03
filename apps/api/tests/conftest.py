"""Shared fixtures.

Production is the default environment, and production refuses to start without the API's shared
secret. Tests that build settings from the environment therefore get a throwaway one (not a
real secret: it exists only inside the test process).
"""

import pytest

TEST_API_SECRET = "test-only-secret-0123456789-abcdefghijklmnopqrstuvwxyz"


@pytest.fixture(autouse=True)
def _test_api_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("API_SHARED_SECRET", TEST_API_SECRET)
