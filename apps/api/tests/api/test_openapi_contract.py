from voice_agent_api.openapi import OPENAPI_PATH, render


def test_committed_openapi_matches_the_app() -> None:
    committed = OPENAPI_PATH.read_text(encoding="utf-8")
    assert committed == render(), (
        "apps/api/openapi.json is stale. Regenerate it with "
        "`python -m uv run python -m voice_agent_api.openapi` "
        "and then run `pnpm gen:api` in apps/web."
    )
