"""Reset the fictional demo appointments in PostgreSQL.

Run from `apps/api`: `python -m uv run python -m voice_agent_api.demo_reset [--yes]`

Deletes the rows this app owns (`source` of `seed` or `web_demo`) and inserts the fresh
seed bookings, relative to now. It needs `APPOINTMENT_STORE=postgres` and refuses otherwise.
"""

import argparse
import sys

from voice_agent_api.config import ConfigError, load_settings
from voice_agent_api.domain.errors import StorageUnavailable
from voice_agent_api.factory import system_clock
from voice_agent_api.infrastructure.postgres import DatabaseFault, build_postgres
from voice_agent_api.infrastructure.seed import seed_bookings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = parser.parse_args(argv)

    try:
        settings = load_settings()
    except ConfigError as exc:
        print(exc)
        return 2
    if settings.appointment_store != "postgres":
        print("Set APPOINTMENT_STORE=postgres first: there is nothing to reset in memory mode.")
        return 2

    if (
        not args.yes
        and input("Delete demo appointments and reseed? Type RESET to continue: ") != "RESET"
    ):
        print("Cancelled.")
        return 1

    _, book, database = build_postgres(settings)
    try:
        database.open()
        deleted = book.replace_demo_data(seed_bookings(system_clock()))
    except (StorageUnavailable, DatabaseFault) as exc:
        print(exc)
        return 1
    finally:
        database.close()
    print(f"Deleted {deleted} demo appointment(s) and inserted fresh seed bookings.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
