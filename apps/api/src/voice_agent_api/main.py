"""ASGI entrypoint: `fastapi dev src/voice_agent_api/main.py`.

Importing this module loads and validates settings (and a git-ignored `.env`) and configures
logging. Library code and tests import `voice_agent_api.factory` instead, which has no
import-time side effects.
"""

import logging

from voice_agent_api.config import load_settings
from voice_agent_api.factory import create_app_from_settings

# Without this, the app's INFO audit lines (confirm outcomes: ids and codes only, never
# tokens or submitted values) would be dropped. Only this entrypoint configures logging.
logging.basicConfig(format="%(levelname)s %(name)s: %(message)s")
logging.getLogger("voice_agent_api").setLevel(logging.INFO)

app = create_app_from_settings(load_settings())
