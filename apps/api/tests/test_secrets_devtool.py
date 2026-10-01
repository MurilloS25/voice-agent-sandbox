from pathlib import Path

import pytest

from voice_agent_api.config import (
    ConfigError,
    Settings,
    decode_signing_key,
    load_settings,
    resolve_signing_key,
    validate_settings,
)
from voice_agent_api.devtools import secrets as devtool

API_ROOT = Path(__file__).resolve().parents[1]


def values(path: Path) -> dict[str, str]:
    pairs = (line.split("=", 1) for line in path.read_text("utf-8").splitlines() if "=" in line)
    return {k: v for k, v in pairs if not k.startswith("#")}


def test_generate_creates_the_file_and_prints_only_names(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    env = tmp_path / ".env"
    assert devtool.main(["--env-file", str(env), "generate"]) == 0

    written = values(env)
    out = capsys.readouterr().out
    assert "PROPOSAL_SIGNING_KEY" in out and "DB_PASSWORD" in out
    assert written["PROPOSAL_SIGNING_KEY"] not in out
    assert written["DB_PASSWORD"] not in out
    assert len(decode_signing_key(written["PROPOSAL_SIGNING_KEY"])) == 32
    assert len(written["DB_PASSWORD"]) >= 43
    assert all(ch.isalnum() or ch in "-_" for ch in written["DB_PASSWORD"])  # no encoding needed
    assert written["APPOINTMENT_STORE"] == "memory"
    assert written["DB_HOST"] == "CHANGE_ME"


def test_generate_refuses_to_overwrite(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("PROPOSAL_SIGNING_KEY=keep-me\n", encoding="utf-8")
    assert devtool.main(["--env-file", str(env), "generate"]) == 2
    assert env.read_text("utf-8") == "PROPOSAL_SIGNING_KEY=keep-me\n"


def test_two_generations_differ(tmp_path: Path) -> None:
    first, second = tmp_path / "a.env", tmp_path / "b.env"
    devtool.main(["--env-file", str(first), "generate"])
    devtool.main(["--env-file", str(second), "generate"])
    assert values(first)["DB_PASSWORD"] != values(second)["DB_PASSWORD"]
    assert values(first)["PROPOSAL_SIGNING_KEY"] != values(second)["PROPOSAL_SIGNING_KEY"]


def test_rotate_replaces_only_the_secrets(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    devtool.main(["--env-file", str(env), "generate"])
    before = values(env)
    env.write_text(
        env.read_text("utf-8").replace("DB_HOST=CHANGE_ME", "DB_HOST=db.example.invalid"),
        encoding="utf-8",
    )

    assert devtool.main(["--env-file", str(env), "generate", "--rotate"]) == 0

    after = values(env)
    assert after["DB_PASSWORD"] != before["DB_PASSWORD"]
    assert after["PROPOSAL_SIGNING_KEY"] != before["PROPOSAL_SIGNING_KEY"]
    assert after["DB_HOST"] == "db.example.invalid"


def test_rotate_needs_an_existing_file(tmp_path: Path) -> None:
    assert devtool.main(["--env-file", str(tmp_path / ".env"), "generate", "--rotate"]) == 2


def test_check_passes_names_only_and_flags_unfilled_placeholders(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    env = tmp_path / ".env"
    devtool.main(["--env-file", str(env), "generate"])
    capsys.readouterr()

    assert devtool.main(["--env-file", str(env), "check"]) == 1  # placeholders unfilled
    out = capsys.readouterr().out
    for name in ("DB_HOST", "DB_USER", "DB_SSLROOTCERT"):
        assert f"FAIL: {name}" in out
    assert "ok  : PROPOSAL_SIGNING_KEY" in out
    assert "ok  : DB_PASSWORD" in out
    for secret in (values(env)["DB_PASSWORD"], values(env)["PROPOSAL_SIGNING_KEY"]):
        assert secret not in out


def test_check_passes_once_the_placeholders_are_filled(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    env = tmp_path / ".env"
    devtool.main(["--env-file", str(env), "generate"])
    text = (
        env.read_text("utf-8")
        .replace("DB_HOST=CHANGE_ME", "DB_HOST=db.example.invalid")
        .replace("voice_agent_api.CHANGE_ME", "voice_agent_api.exampleref")
        .replace("DB_SSLROOTCERT=CHANGE_ME", "DB_SSLROOTCERT=/certs/ca.pem")
    )
    env.write_text(text, encoding="utf-8")
    capsys.readouterr()

    assert devtool.main(["--env-file", str(env), "check"]) == 0


def test_check_reports_a_missing_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert devtool.main(["--env-file", str(tmp_path / "nope.env"), "check"]) == 1
    assert "does not exist" in capsys.readouterr().out


def test_env_example_holds_placeholders_only() -> None:
    example = values(API_ROOT / ".env.example")
    assert {"PROPOSAL_SIGNING_KEY", "DB_PASSWORD"} <= set(example)
    non_secret_defaults = {
        "APPOINTMENT_STORE": "memory",
        "BUSINESS_ID": "quillwheel",
        "DB_PORT": "5432",
        "DB_NAME": "postgres",
        "DB_SSLMODE": "verify-full",
    }
    for name, value in example.items():
        if name in non_secret_defaults:
            assert value == non_secret_defaults[name]
        else:
            assert value == "" or "CHANGE_ME" in value, f"{name} must be a placeholder"


def test_env_example_works_in_memory_mode_but_not_for_postgres() -> None:
    settings = load_settings(env_file=str(API_ROOT / ".env.example"))
    assert isinstance(settings, Settings)
    assert len(resolve_signing_key(settings)) == 32  # placeholder key = unset: ephemeral key

    postgres = settings.model_copy(update={"appointment_store": "postgres"})
    with pytest.raises(ConfigError):  # every placeholder must be replaced first
        validate_settings(postgres)
    with pytest.raises(ConfigError):
        resolve_signing_key(postgres)
