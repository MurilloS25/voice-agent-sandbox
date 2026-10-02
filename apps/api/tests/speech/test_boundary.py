"""Static guards for the speech package and its route."""

import ast
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[2] / "src" / "voice_agent_api"
SPEECH = SRC / "speech"
SPEECH_FILES = sorted(SPEECH.glob("*.py"))
ROUTE = SRC / "api" / "speech_routes.py"
AGENT_FILES = sorted((SRC / "agent").glob("*.py"))


def modules_imported(path: Path) -> list[str]:
    found: list[str] = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            found.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            found.append(node.module)
    return found


def test_the_speech_package_exists_and_is_scanned() -> None:
    assert {f.name for f in SPEECH_FILES} >= {
        "bounded.py",
        "contracts.py",
        "errors.py",
        "limits.py",
        "ports.py",
        "sniff.py",
    }


@pytest.mark.parametrize("path", SPEECH_FILES, ids=lambda p: p.name)
def test_speech_does_not_import_the_agent_the_api_or_storage(path: Path) -> None:
    for module in modules_imported(path):
        for forbidden in (
            "voice_agent_api.agent",
            "voice_agent_api.api",
            "voice_agent_api.infrastructure",
            "voice_agent_api.factory",
        ):
            assert module != forbidden and not module.startswith(forbidden + "."), (
                f"{path.name} imports {module}"
            )


@pytest.mark.parametrize("path", AGENT_FILES, ids=lambda p: p.name)
def test_the_agent_does_not_import_speech(path: Path) -> None:
    for module in modules_imported(path):
        assert not module.startswith("voice_agent_api.speech"), f"{path.name} imports {module}"


@pytest.mark.parametrize("path", SPEECH_FILES, ids=lambda p: p.name)
def test_speech_has_no_provider_sdk_no_network_and_no_files(path: Path) -> None:
    banned = {
        "groq",
        "langchain_groq",
        "openai",
        "httpx",
        "requests",
        "aiohttp",
        "urllib",
        "socket",
        "tempfile",
        "shutil",
        "subprocess",
    }
    for module in modules_imported(path):
        assert module.split(".")[0] not in banned, f"{path.name} imports {module}"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            assert node.func.id != "open", f"{path.name} opens a file"


def test_the_route_reads_the_stream_and_never_uses_an_accumulating_api() -> None:
    tree = ast.parse(ROUTE.read_text(encoding="utf-8"))
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    attributes = {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
    imported = {a.name for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) for a in n.names}

    assert "stream" in attributes
    assert not {"UploadFile", "File", "Form", "Body"} & (names | imported)
    assert not {"body", "form", "json"} & attributes  # Request.body(), .form(), .json()
    roots = {module.split(".")[0] for module in modules_imported(ROUTE)}
    assert not {"python_multipart", "multipart"} & roots


def test_the_application_never_names_python_multipart() -> None:
    for path in SRC.rglob("*.py"):
        for module in modules_imported(path):
            assert module.split(".")[0] not in {"python_multipart", "multipart"}, path.name
