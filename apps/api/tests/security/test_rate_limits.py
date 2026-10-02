"""Token buckets, the category map and the 429 answers. A manual clock: nothing sleeps."""

import pytest

from tests.security.support import AUTH, CLIENT_A, CLIENT_B, Clock, Protected, limits
from voice_agent_api.security.middleware import categorize, parse_client_id
from voice_agent_api.security.ratelimit import Category, Policy, TokenBuckets


def test_a_policy_must_be_positive_and_gets_a_half_minute_burst() -> None:
    with pytest.raises(ValueError):
        Policy(0, 1)
    with pytest.raises(ValueError):
        Policy(1, 0)
    assert Policy.per_minute(6) == Policy(6, 3)
    assert Policy.per_minute(1) == Policy(1, 1)
    assert Policy.per_minute(60).burst == 30


def test_a_bucket_allows_the_burst_then_says_how_long_to_wait() -> None:
    clock = Clock()
    buckets = TokenBuckets(clock)
    policy = Policy(per_min=6, burst=3)  # one token every 10 s
    assert [buckets.take("a", policy) for _ in range(3)] == [None, None, None]
    assert buckets.take("a", policy) == 10
    clock.advance(4)
    assert buckets.take("a", policy) == 6
    clock.advance(6)
    assert buckets.take("a", policy) is None
    assert buckets.take("a", policy) == 10


def test_the_wait_is_whole_seconds_and_never_below_one() -> None:
    clock = Clock()
    buckets = TokenBuckets(clock)
    policy = Policy(per_min=600, burst=1)  # a token every 0.1 s
    assert buckets.take("a", policy) is None
    assert buckets.take("a", policy) == 1


def test_a_bucket_never_holds_more_than_its_burst() -> None:
    clock = Clock()
    buckets = TokenBuckets(clock)
    policy = Policy(per_min=6, burst=3)
    buckets.take("a", policy)
    clock.advance(3600)  # an hour of idleness refills only to the burst
    assert [buckets.take("a", policy) for _ in range(3)] == [None, None, None]
    assert buckets.take("a", policy) == 10


def test_clients_have_independent_buckets() -> None:
    buckets = TokenBuckets(Clock())
    policy = Policy(per_min=6, burst=1)
    assert buckets.take("a", policy) is None
    assert buckets.take("a", policy) is not None
    assert buckets.take("b", policy) is None


def test_memory_is_bounded_and_idle_buckets_expire() -> None:
    clock = Clock()
    buckets = TokenBuckets(clock, max_buckets=3)
    policy = Policy(per_min=6, burst=3)
    for key in "abcdef":
        buckets.take(key, policy)
    assert len(buckets) == 3  # the least recently used were dropped
    clock.advance(31)  # a full refill takes burst / rate = 30 s
    buckets.take("z", policy)
    assert len(buckets) == 1  # everything idle for a full refill is indistinguishable from new


def test_an_evicted_client_starts_fresh_instead_of_being_blocked() -> None:
    buckets = TokenBuckets(Clock(), max_buckets=1)
    policy = Policy(per_min=6, burst=1)
    buckets.take("a", policy)
    buckets.take("b", policy)
    assert buckets.take("a", policy) is None  # fail open for the evicted, never a lockout


def test_cleanup_happens_inside_take_without_a_background_task() -> None:
    import threading

    before = threading.active_count()
    clock = Clock()
    buckets = TokenBuckets(clock)
    policy = Policy(per_min=6, burst=3)
    for index in range(100):
        buckets.take(f"k{index}", policy)
    clock.advance(60)
    buckets.take("fresh", policy)
    assert len(buckets) == 1
    assert threading.active_count() == before


def test_the_overall_limit_is_shared_and_a_refused_client_keeps_its_token() -> None:
    clock = Clock()
    rate = limits(clock, agent=(60, 2))  # per client 60/min; overall 2/min -> burst 1
    assert rate.check(Category.AGENT, CLIENT_A) is None
    assert rate.check(Category.AGENT, CLIENT_B) is not None  # overall exhausted
    # B was refused by the overall bucket: its own token was given back.
    clock.advance(30)
    assert rate.check(Category.AGENT, CLIENT_B) is None


def test_every_category_needs_a_limit() -> None:
    from voice_agent_api.security.ratelimit import CategoryLimits, RateLimits

    pair = CategoryLimits(Policy(1, 1), Policy(1, 1))
    with pytest.raises(ValueError):
        RateLimits({Category.AGENT: pair}, Clock())


@pytest.mark.parametrize(
    ("method", "path", "category"),
    [
        ("POST", "/v1/agent/turns", Category.AGENT),
        ("POST", "/v1/speech/transcriptions", Category.SPEECH),
        ("POST", "/v1/appointment-proposals", Category.WRITE),
        ("POST", "/v1/appointments", Category.WRITE),
        ("GET", "/v1/business", Category.READ),
        ("GET", "/v1/services", Category.READ),
        ("GET", "/v1/services/flat-repair/availability", Category.READ),
        ("GET", "/v1/appointments/abc", Category.READ),
        ("GET", "/v1/agent/turns", None),
        ("POST", "/v1/business", None),
        ("GET", "/v1/appointments/a/b", None),
        ("GET", "/nope", None),
    ],
)
def test_each_route_has_its_own_category(method: str, path: str, category: Category | None) -> None:
    assert categorize(method, path) == category


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, "unattributed"),
        (b"a" * 32, "a" * 32),
        (b"A" * 32, "unattributed"),  # hex is lower case
        (b"a" * 31, "unattributed"),
        (b"a" * 33, "unattributed"),
        (b"g" * 32, "unattributed"),
        (b"\xff" * 32, "unattributed"),
        (b"", "unattributed"),
    ],
)
def test_a_client_id_is_a_32_character_hex_string_or_the_shared_unattributed_key(
    raw: bytes | None, expected: str
) -> None:
    assert parse_client_id(raw) == expected


# --- through the app -------------------------------------------------------------------------


def test_the_agent_route_answers_429_with_retry_after_before_calling_the_model() -> None:
    clock = Clock()
    api = Protected(clock=clock, rate_limits=limits(clock, agent=(2, 600)), steps=[])
    # The scripted model has no steps: a call would raise. Only the first request is allowed
    # through to the agent (burst 1); the second must be refused before the agent runs.
    first = api.turn("one", index=1)
    assert first.status_code == 200
    second = api.turn("two", index=2)
    assert second.status_code == 429
    assert second.json() == {
        "error": {"code": "rate_limited", "message": "Too many requests. Try again shortly."}
    }
    assert second.headers["retry-after"] == "30"
    assert len(api.world.model.calls) == 1  # no second model call


def test_the_429_leaks_nothing_about_the_limit_or_the_client() -> None:
    clock = Clock()
    api = Protected(clock=clock, rate_limits=limits(clock, agent=(2, 600)))
    api.turn("one")
    response = api.turn("two", client=CLIENT_B)
    text = response.text + str(dict(response.headers))
    for forbidden in (CLIENT_A, CLIENT_B, "per_min", "burst", "bucket", "client"):
        assert forbidden not in text


def test_limits_recover_with_time_and_are_per_client() -> None:
    clock = Clock()
    api = Protected(clock=clock, rate_limits=limits(clock, agent=(2, 600)))
    assert api.turn("a", index=1, client=CLIENT_A).status_code == 200
    assert api.turn("b", index=2, client=CLIENT_A).status_code == 429
    assert api.turn("c", index=2, client=CLIENT_B).status_code == 200
    clock.advance(31)
    assert api.turn("d", index=3, client=CLIENT_A).status_code == 200


def test_each_category_is_limited_on_its_own() -> None:
    clock = Clock()
    api = Protected(clock=clock, rate_limits=limits(clock, agent=(2, 600), read=(60, 300)))
    api.turn("a")
    assert api.turn("b", index=2).status_code == 429
    headers = {**AUTH, "X-Client-Id": CLIENT_A}
    assert api.client.get("/v1/business", headers=headers).status_code == 200  # reads unaffected


def test_a_forged_forwarded_for_header_changes_nothing() -> None:
    clock = Clock()
    api = Protected(clock=clock, rate_limits=limits(clock, agent=(2, 600)))
    headers = {**AUTH, "X-Client-Id": CLIENT_A}

    def body(i: int) -> dict[str, object]:
        return {
            "conversation_id": str(api.world.conversation_id),
            "client_turn_id": f"00000000-0000-4000-8000-{i:012d}",
            "turn_index": i,
            "message": "hi",
        }

    assert api.client.post("/v1/agent/turns", headers=headers, json=body(1)).status_code == 200
    for spoof in ("1.2.3.4", "9.9.9.9", "10.0.0.1, 8.8.8.8"):
        forged = {
            **headers,
            "X-Forwarded-For": spoof,
            "Forwarded": f"for={spoof}",
            "X-Real-IP": spoof,
        }
        assert api.client.post("/v1/agent/turns", headers=forged, json=body(2)).status_code == 429


def test_a_malformed_client_id_cannot_open_a_fresh_bucket() -> None:
    clock = Clock()
    api = Protected(clock=clock, rate_limits=limits(clock, agent=(2, 600)))
    results = [api.turn(f"m{i}", index=i + 1, client=f"not-hex-{i}").status_code for i in range(3)]
    assert results == [200, 429, 429]  # one shared strict bucket for everything unattributed


def test_the_number_of_tracked_clients_stays_bounded() -> None:
    clock = Clock()
    api = Protected(clock=clock, rate_limits=limits(clock, read=(60, 300), max_clients=50))
    for index in range(200):
        api.client.get("/v1/business", headers={**AUTH, "X-Client-Id": f"{index:032x}"})
    assert api.rate_limits.tracked_clients() <= 50 * 4
    assert len(api.world.model.calls) == 0
