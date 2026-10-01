"""Write the OpenAPI schema to `apps/api/openapi.json`.

Run from `apps/api`: `python -m uv run python -m voice_agent_api.openapi`
"""

import json
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI

from voice_agent_api.factory import create_app, system_clock
from voice_agent_api.infrastructure.seed import build_seed

OPENAPI_PATH = Path(__file__).resolve().parents[2] / "openapi.json"


def build_app() -> FastAPI:
    """An in-memory app: the schema never depends on settings, `.env` or a database."""
    catalog, appointments = build_seed(datetime.now(UTC))
    return create_app(catalog, appointments, system_clock)


def render() -> str:
    return json.dumps(build_app().openapi(), indent=2, sort_keys=True) + "\n"


def main() -> None:
    OPENAPI_PATH.write_text(render(), encoding="utf-8", newline="\n")
    print(f"Wrote {OPENAPI_PATH}")


if __name__ == "__main__":
    main()
