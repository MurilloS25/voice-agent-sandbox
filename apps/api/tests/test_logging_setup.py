import logging

from voice_agent_api.logging_setup import configure_logging


def test_driver_logs_that_name_the_host_or_login_role_are_silenced() -> None:
    configure_logging()
    for name in ("psycopg", "psycopg.pool"):
        logger = logging.getLogger(name)
        assert not logger.isEnabledFor(logging.WARNING)
        assert not logger.isEnabledFor(logging.ERROR)
    assert logging.getLogger("voice_agent_api").isEnabledFor(logging.INFO)
