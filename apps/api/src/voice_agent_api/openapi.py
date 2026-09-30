"""Write the OpenAPI schema to `apps/api/openapi.json`.

Run from `apps/api`: `python -m uv run python -m voice_agent_api.openapi`
"""

import json
from pathlib import Path

from voice_agent_api.main import app

OPENAPI_PATH = Path(__file__).resolve().parents[2] / "openapi.json"


def render() -> str:
    return json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n"


def main() -> None:
    OPENAPI_PATH.write_text(render(), encoding="utf-8", newline="\n")
    print(f"Wrote {OPENAPI_PATH}")


if __name__ == "__main__":
    main()
