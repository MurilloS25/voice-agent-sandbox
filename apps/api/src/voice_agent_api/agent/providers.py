"""The provider-neutral model factory and error classification.

Orchestration depends only on `langchain_core`'s `BaseChatModel`. This is the one module that
knows about a vendor: `langchain_groq` is imported inside the builder, so importing the agent
package never loads it and a disabled provider never needs it.

No model id is chosen here: `AGENT_MODEL` comes from settings. No automatic retries: the client is
built with `max_retries=0`, so one turn's model calls are bounded by the turn deadline alone.
Nothing here logs a key, a request body, a response or reasoning.
"""

import logging
import os
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel

from voice_agent_api.agent.errors import ProviderError
from voice_agent_api.agent.events import ProviderCode
from voice_agent_api.config import ConfigError, Settings

GROQ_BASE_URL = "https://api.groq.com"  # pinned: never taken from the environment
_TRACING_VARIABLES = (
    "LANGSMITH_TRACING",
    "LANGSMITH_TRACING_V2",
    "LANGCHAIN_TRACING_V2",
    "LANGCHAIN_TRACING",
)
logger = logging.getLogger("voice_agent_api")
_PROVIDER_CODES = {"model_timeout", "model_rate_limited", "model_unavailable", "model_bad_output"}


def build_chat_model(settings: Settings, *, http_client: Any | None = None) -> BaseChatModel | None:
    """None when the provider is disabled (the agent route then answers 503). `http_client` lets
    tests inject a transport so no request ever leaves the machine."""
    if settings.agent_provider == "disabled":
        return None
    if settings.agent_provider == "groq":
        return _build_groq(settings, http_client)
    raise ConfigError


def _quiet_provider_loggers() -> None:
    """The Groq SDK logs whole request bodies (system prompt and visitor text) at DEBUG. Pin its
    loggers, and the HTTP stack's, to WARNING so that no root-logger setting can write provider
    payloads to a log."""
    for name in ("groq", "httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)


def _refuse_tracing() -> None:
    """Tracing would send prompts, visitor text and tool results to a third party. The project
    never enables it, so a host that does (a stray environment variable) fails startup, naming
    only the variable."""
    for name in _TRACING_VARIABLES:
        if os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}:
            logger.error("Invalid server configuration: %s must not enable tracing", name)
            raise ConfigError


def _build_groq(settings: Settings, http_client: Any | None) -> BaseChatModel:
    from langchain_groq import ChatGroq

    _refuse_tracing()
    _quiet_provider_loggers()
    if settings.groq_api_key is None or not settings.agent_model:
        raise ConfigError  # validate_settings rejects this earlier; fail closed regardless
    model_kwargs: dict[str, Any] = {}
    extra: dict[str, Any] = {}
    if settings.agent_reasoning_control == "include_reasoning":
        model_kwargs["include_reasoning"] = False
    elif settings.agent_reasoning_control == "reasoning_format":
        extra["reasoning_format"] = "hidden"
    if settings.agent_reasoning_effort != "off":
        extra["reasoning_effort"] = settings.agent_reasoning_effort
    return ChatGroq(
        model=settings.agent_model,
        api_key=settings.groq_api_key,
        base_url=GROQ_BASE_URL,
        temperature=settings.agent_temperature,
        max_tokens=settings.agent_max_output_tokens,
        timeout=settings.agent_model_timeout_s,
        max_retries=0,
        model_kwargs=model_kwargs,
        http_client=http_client,
        **extra,
    )


def _in_mro(exc: BaseException, fragment: str) -> bool:
    return any(fragment in cls.__name__ for cls in type(exc).__mro__)


def classify_provider_error(exc: Exception) -> ProviderCode:
    """Provider-neutral mapping to the `provider_error` event codes.

    Adapters may raise `ProviderError`. Otherwise only an HTTP-style `status_code` attribute and
    the exception's class names are used (never its message, which can echo request content):
    429 is rate limiting, a timeout class or 408/504 is a timeout, 400/422 means the provider
    rejected or could not produce valid output, and everything else (auth, 5xx, connection
    failure) is unavailable."""
    if isinstance(exc, ProviderError) and exc.code in _PROVIDER_CODES:
        return exc.code  # type: ignore[return-value]
    status = getattr(exc, "status_code", None)
    if status == 429:
        return "model_rate_limited"
    if isinstance(exc, TimeoutError) or _in_mro(exc, "Timeout") or status in (408, 504):
        return "model_timeout"
    if status in (400, 422):
        return "model_bad_output"
    return "model_unavailable"
