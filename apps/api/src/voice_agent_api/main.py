"""ASGI entrypoint: `fastapi dev src/voice_agent_api/main.py`.

Importing this module loads and validates settings (and a git-ignored `.env`) and configures
logging. Library code and tests import `voice_agent_api.factory` instead, which has no
import-time side effects.
"""

from voice_agent_api.config import load_settings
from voice_agent_api.factory import create_app_from_settings
from voice_agent_api.logging_setup import configure_logging

configure_logging()

app = create_app_from_settings(load_settings())
