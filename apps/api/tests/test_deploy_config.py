"""Static checks of the deployment files: nothing secret, nothing unpinned, nothing unsafe."""

import hashlib
import re
import ssl
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DOCKERFILE = (ROOT / "apps" / "api" / "Dockerfile").read_text("utf-8")
RENDER = (ROOT / "render.yaml").read_text("utf-8")
DOCKERIGNORE = (ROOT / ".dockerignore").read_text("utf-8")
PRODUCTION_EXAMPLE = (ROOT / "apps" / "api" / ".env.production.example").read_text("utf-8")
WEB_EXAMPLE = (ROOT / "apps" / "web" / ".env.production.example").read_text("utf-8")

SECRET_NAMES = [
    "API_SHARED_SECRET",
    "PROPOSAL_SIGNING_KEY",
    "DB_PASSWORD",
    "GROQ_API_KEY",
    "DB_HOST",
    "DB_USER",
]


def test_the_image_is_pinned_multi_stage_and_non_root() -> None:
    froms = re.findall(r"^FROM (\S+)", DOCKERFILE, re.MULTILINE)
    assert len(froms) == 2 and all("@sha256:" in image for image in froms)
    assert re.search(r'"uv==\d+\.\d+\.\d+"', DOCKERFILE)
    assert re.search(r"^USER app$", DOCKERFILE, re.MULTILINE)
    assert "--frozen" in DOCKERFILE and "--no-dev" in DOCKERFILE


def test_the_image_never_receives_a_secret_at_build_time() -> None:
    assert "ARG " not in DOCKERFILE
    for name in SECRET_NAMES:
        assert f"ENV {name}" not in DOCKERFILE and f"{name}=" not in DOCKERFILE


def test_the_server_runs_one_worker_without_access_log_or_proxy_trust() -> None:
    command = DOCKERFILE[DOCKERFILE.index("CMD ") :]
    for flag in ("--workers 1", "--no-access-log", "--no-proxy-headers"):
        assert flag in command
    assert "--reload" not in command and "--forwarded-allow-ips" not in command


def test_the_context_excludes_environment_files_tests_and_the_web_app() -> None:
    for pattern in (".env", ".env.*", "apps/web", "apps/api/tests", ".git"):
        assert pattern in DOCKERIGNORE.splitlines()


def test_render_blueprint_carries_no_secret_values_and_uses_the_free_plan() -> None:
    assert "plan: free" in RENDER and "maxShutdownDelaySeconds: 30" in RENDER
    assert "healthCheckPath: /health/ready" in RENDER
    for name in SECRET_NAMES:
        block = re.search(rf"- key: {name}\n(\s+)(\S+)", RENDER)
        assert block is not None, name
        assert block.group(2) == "sync:", name  # `sync: false`: entered in the dashboard only


def test_the_example_files_list_names_only() -> None:
    for text in (PRODUCTION_EXAMPLE, WEB_EXAMPLE):
        for line in text.splitlines():
            match = re.match(r"^([A-Z_]+)=(\S*)", line)
            if match and match.group(1) in [*SECRET_NAMES, "CLIENT_ID_KEY"]:
                assert match.group(2) == "", line
    assert "NEXT_PUBLIC" not in WEB_EXAMPLE.replace("none of these starts with NEXT_PUBLIC_", "")


def test_the_ca_certificate_is_one_public_certificate_at_the_agreed_path() -> None:
    pem = (ROOT / "apps" / "api" / "certs" / "supabase-ca.crt").read_text("ascii")
    assert pem.count("-----BEGIN CERTIFICATE-----") == 1
    assert pem.count("-----END CERTIFICATE-----") == 1
    assert "PRIVATE KEY" not in pem and pem.count("-----BEGIN") == 1
    der = ssl.PEM_cert_to_DER_cert(pem)
    assert (
        hashlib.sha256(der).hexdigest().upper()
        == "807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA"
    )


def test_the_certificate_path_agrees_in_dockerfile_blueprint_and_example() -> None:
    assert "COPY --chown=app:app apps/api/certs /app/certs" in DOCKERFILE
    assert "value: /app/certs/supabase-ca.crt" in RENDER
    assert "DB_SSLROOTCERT=/app/certs/supabase-ca.crt" in PRODUCTION_EXAMPLE
    assert "value: verify-full" in RENDER and "DB_SSLMODE=verify-full" in PRODUCTION_EXAMPLE


def test_the_blueprint_is_one_free_instance_in_virginia() -> None:
    assert "plan: free" in RENDER and "region: virginia" in RENDER
    assert "numInstances: 1" in RENDER and "type: web" in RENDER
    assert RENDER.count("- type:") == 1
