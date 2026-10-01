"""Static guards: the agent package cannot reach the write path, storage adapters or the network."""

import ast
from pathlib import Path

import pytest

AGENT = Path(__file__).resolve().parents[2] / "src" / "voice_agent_api" / "agent"
FILES = sorted(AGENT.glob("*.py"))

FORBIDDEN_MODULES = (
    "voice_agent_api.infrastructure",
    "voice_agent_api.api.routes",
    "voice_agent_api.api.dependencies",
    "voice_agent_api.api.errors",
    "langchain_groq",
    "langsmith",
    "httpx",
    "requests",
    "socket",
    "urllib",
    "aiohttp",
)
FORBIDDEN_NAMES = {"confirm_appointment"}


def modules_imported(tree: ast.AST) -> list[str]:
    found: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            found.append(node.module)
    return found


def test_the_agent_package_exists_and_is_scanned() -> None:
    assert {f.name for f in FILES} >= {"orchestrator.py", "tools.py", "graph.py", "store.py"}


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_no_forbidden_imports(path: Path) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for module in modules_imported(tree):
        for forbidden in FORBIDDEN_MODULES:
            assert module != forbidden and not module.startswith(forbidden + "."), (
                f"{path.name} imports {module}"
            )


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_no_reference_to_the_confirmation_or_write_path(path: Path) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.alias):
            assert node.name not in FORBIDDEN_NAMES, f"{path.name} imports {node.name}"
        if isinstance(node, ast.Name):
            assert node.id not in FORBIDDEN_NAMES, f"{path.name} uses {node.id}"
        if isinstance(node, ast.Attribute):
            assert node.attr not in FORBIDDEN_NAMES, f"{path.name} uses .{node.attr}"
            if path.name != "readonly.py":
                # Only the read-only wrapper may even mention the port's write method.
                assert node.attr != "confirm", f"{path.name} calls .confirm"


def test_the_orchestrator_hands_the_tools_only_the_read_only_book() -> None:
    source = (AGENT / "orchestrator.py").read_text(encoding="utf-8")
    assert "ReadOnlyAppointmentBook(appointments)" in source
    assert "ToolExecutor(catalog, self._book" in source


def test_the_agent_package_has_no_async_functions() -> None:
    for path in FILES:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        assert not [n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef)], path.name
