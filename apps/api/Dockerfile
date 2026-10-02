# syntax=docker/dockerfile:1
# Build context: the REPOSITORY ROOT (so the lockfile and the API sources are one tree):
#   docker build -f apps/api/Dockerfile -t voice-agent-api .
# No secret is read at build time or baked into a layer: every setting arrives as a runtime
# environment variable. The base image is pinned by digest (python:3.13.12-slim-bookworm).

FROM python@sha256:a58daefb915e1e03ad48f3ca4df8832065412c5c35cacb9d39f4229184de12b6 AS build
ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
RUN pip install "uv==0.12.21"
WORKDIR /app
COPY apps/api/pyproject.toml apps/api/uv.lock apps/api/README.md ./
COPY apps/api/src ./src
# Locked, production-only, non-editable install. The virtualenv is built at the path it runs at
# (/app/.venv), because its scripts carry absolute interpreter paths.
RUN uv sync --frozen --no-dev --no-editable --python /usr/local/bin/python

FROM python@sha256:a58daefb915e1e03ad48f3ca4df8832065412c5c35cacb9d39f4229184de12b6 AS runtime
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PATH="/app/.venv/bin:$PATH" APP_ENV=production
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --home-dir /app --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=build --chown=app:app /app/.venv /app/.venv
# The PUBLIC CA certificate for verify-full lives here (see apps/api/certs/README.md); it is
# shipped in the image, never downloaded at runtime.
COPY --chown=app:app apps/api/certs /app/certs
USER app
EXPOSE 10000
# Exec form so the server is PID 1 and receives SIGTERM. One worker (the in-memory limits and
# conversations are per process), no access log (it would record paths), and no proxy-header
# trust: the API never reads a client address, the web tier sends a keyed identifier instead.
CMD ["sh", "-c", "exec python -m uvicorn voice_agent_api.main:app --host 0.0.0.0 --port ${PORT:-10000} --workers 1 --no-access-log --no-proxy-headers --no-server-header --timeout-graceful-shutdown 25"]
