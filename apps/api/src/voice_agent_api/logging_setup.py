"""Logging for the ASGI entrypoint (the only place that configures it)."""

import logging

# The database driver's own messages name the host and the login role (which carries the project
# reference) when a connection fails. They are kept out of the logs; the app reports only that
# storage is unavailable.
_SILENCED = ("psycopg", "psycopg.pool")


def configure_logging() -> None:
    # Without this, the app's INFO audit lines (outcome codes and route templates only: never an
    # identifier, a token or a submitted value) would be dropped.
    logging.basicConfig(format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("voice_agent_api").setLevel(logging.INFO)
    for name in _SILENCED:
        logging.getLogger(name).setLevel(logging.CRITICAL)
