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
        "fake.py",
        "providers.py",
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


# The one module that may know a vendor SDK, and only inside a function.
ALLOWED_VENDOR_IMPORTS = {"providers.py": ("groq",)}


@pytest.mark.parametrize("path", SPEECH_FILES, ids=lambda p: p.name)
def test_speech_has_no_stray_sdk_network_or_file_access(path: Path) -> None:
    banned = {
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
        "groq",
    }
    allowed = ALLOWED_VENDOR_IMPORTS.get(path.name, ())
    for module in modules_imported(path):
        root = module.split(".")[0]
        assert root not in banned or root in allowed, f"{path.name} imports {module}"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            assert node.func.id != "open", f"{path.name} opens a file"


def test_only_the_provider_module_imports_the_vendor_and_only_lazily() -> None:
    importers = []
    for path in SPEECH_FILES:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        if any(m.split(".")[0] == "groq" for m in modules_imported(path)):
            importers.append(path.name)
            for node in tree.body:  # module level only; function bodies are nested
                if isinstance(node, ast.Import):
                    names = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    names = [node.module or ""]
                else:
                    continue
                assert not any(n.split(".")[0] == "groq" for n in names), (
                    "groq must be imported inside the adapter, not at module level"
                )
    assert importers == ["providers.py"]


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
