"""Local secret provisioning. Run from `apps/api`:

    python -m uv run python -m voice_agent_api.devtools.secrets generate [--rotate]
    python -m uv run python -m voice_agent_api.devtools.secrets check [--connect]

`generate` draws `PROPOSAL_SIGNING_KEY` and `DB_PASSWORD` from the operating system's secure
random source and writes them to the git-ignored `apps/api/.env`. It never prints a value, only
the names it wrote. `check` validates the file and prints pass or fail per variable name.
Neither command ever shows a secret, a length, or a connection error's detail.
"""

import argparse
import logging
import os
import secrets as std_secrets
import sys
from pathlib import Path

from voice_agent_api.config import (
    ConfigError,
    Settings,
    failed_settings,
    generate_signing_key,
    load_settings,
)

DEFAULT_ENV_PATH = Path(__file__).resolve().parents[3] / ".env"
_SECRET_NAMES = ("PROPOSAL_SIGNING_KEY", "DB_PASSWORD")

_TEMPLATE = """\
# Local settings. This file is git-ignored: never commit it or paste it anywhere.
# Secrets below were generated locally by `voice_agent_api.devtools.secrets generate`.
PROPOSAL_SIGNING_KEY={signing_key}
DB_PASSWORD={db_password}

# Switch to `postgres` once the database is provisioned and the values below are filled in.
APPOINTMENT_STORE=memory
DB_HOST=CHANGE_ME
DB_USER=voice_agent_api.CHANGE_ME
DB_SSLROOTCERT=CHANGE_ME
"""


def _new_values() -> dict[str, str]:
    return {
        "PROPOSAL_SIGNING_KEY": generate_signing_key(),
        # 32 random bytes in URL-safe base64: no percent-encoding needed anywhere.
        "DB_PASSWORD": std_secrets.token_urlsafe(32),
    }


def _write_private(path: Path, text: str) -> None:
    """Create `path` exclusively with owner-only permissions (0600; Windows ignores the mode)."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def generate(path: Path, rotate: bool) -> int:
    values = _new_values()
    if rotate:
        if not path.exists():
            print(f"{path.name} does not exist; run generate without --rotate first.")
            return 2
        lines = path.read_text(encoding="utf-8").splitlines()
        seen: set[str] = set()
        for index, line in enumerate(lines):
            name = line.split("=", 1)[0]
            if name in values and "=" in line:
                lines[index] = f"{name}={values[name]}"
                seen.add(name)
        lines.extend(f"{name}={value}" for name, value in values.items() if name not in seen)
        tmp = path.with_name(path.name + ".tmp")
        tmp.unlink(missing_ok=True)  # a stale temp file from a crashed rotation
        try:
            _write_private(tmp, "\n".join(lines) + "\n")
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)
    else:
        try:
            _write_private(
                path,
                _TEMPLATE.format(
                    signing_key=values["PROPOSAL_SIGNING_KEY"],
                    db_password=values["DB_PASSWORD"],
                ),
            )
        except FileExistsError:
            print(
                f"{path.name} already exists and was not changed. Use --rotate to replace secrets."
            )
            return 2
    print(f"Wrote {', '.join(_SECRET_NAMES)} to {path.name} (values not shown).")
    if rotate:
        print("Set the new DB_PASSWORD on the role with psql, then restart the API.")
    return 0


def check(path: Path, connect: bool) -> int:
    logging.basicConfig(level=logging.WARNING, format="%(message)s")
    if not path.exists():
        print(f"FAIL: {path.name} does not exist.")
        return 1
    try:
        settings = load_settings(env_file=str(path))
    except ConfigError:
        print("FAIL: settings could not be loaded (see the setting names logged above).")
        return 1
    postgres: Settings = settings.model_copy(update={"appointment_store": "postgres"})
    failed = failed_settings(postgres)
    agent_names = ("GROQ_API_KEY", "AGENT_MODEL")
    for name in sorted(set(_SECRET_NAMES) | set(failed) - set(agent_names)):
        print(f"{'FAIL' if name in failed else 'ok  '}: {name}")
    # The provider is optional: nothing is required (and no key is inspected) while it is disabled.
    if settings.agent_provider == "disabled":
        print("ok  : AGENT_PROVIDER=disabled (GROQ_API_KEY and AGENT_MODEL not required)")
    else:
        for name in agent_names:
            print(f"{'FAIL' if name in failed else 'ok  '}: {name}")
    if failed:
        return 1
    if not connect:
        return 0

    from voice_agent_api.domain.errors import StorageUnavailable
    from voice_agent_api.infrastructure.postgres import PostgresDatabase

    database = PostgresDatabase(postgres)
    try:
        database.open()
    except StorageUnavailable:
        print("FAIL: could not open a database connection (class and SQLSTATE logged above).")
        return 1
    database.close()
    print("ok  : database connection")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="voice_agent_api.devtools.secrets", description=__doc__)
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_PATH, help=argparse.SUPPRESS)
    commands = parser.add_subparsers(dest="command", required=True)
    gen = commands.add_parser("generate", help="create .env with fresh random secrets")
    gen.add_argument(
        "--rotate", action="store_true", help="replace the secrets in an existing .env"
    )
    chk = commands.add_parser("check", help="validate .env without printing any value")
    chk.add_argument("--connect", action="store_true", help="also open one database connection")
    args = parser.parse_args(argv)
    if args.command == "generate":
        return generate(args.env_file, args.rotate)
    return check(args.env_file, args.connect)


if __name__ == "__main__":
    sys.exit(main())
