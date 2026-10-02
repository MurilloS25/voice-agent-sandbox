"""Exception handlers that turn every failure into the structured error envelope."""

import logging
from collections.abc import Awaitable, Callable
from http import HTTPStatus

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from voice_agent_api.agent.errors import (
    AgentBusy,
    AgentUnavailable,
    ConversationBusy,
    ConversationExpired,
    ConversationLimitReached,
    ConversationNotFound,
    IdempotencyKeyReused,
    TurnInProgress,
    TurnOutOfOrder,
)
from voice_agent_api.api.schemas import ErrorBody, ErrorFieldDetail, ErrorResponse
from voice_agent_api.domain.errors import (
    AppointmentNotFound,
    DateOutsideBookingWindow,
    DomainError,
    ProposalExpired,
    ProposalInvalid,
    ProposalStale,
    ServiceNotFound,
    SlotNotOffered,
    SlotUnavailable,
    StorageUnavailable,
)
from voice_agent_api.speech.errors import (
    AudioInvalid,
    AudioTooLarge,
    AudioUnsupported,
    NoSpeech,
    SpeechBusy,
    SpeechUnavailable,
    TranscriptionFailed,
    TranscriptionTimeout,
)

logger = logging.getLogger("voice_agent_api")

ExceptionHandler = Callable[[Request, Exception], Awaitable[JSONResponse]]


def _envelope(
    status_code: int, body: ErrorBody, headers: dict[str, str] | None = None
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=ErrorResponse(error=body).model_dump(mode="json", exclude_none=True),
        headers=headers,
    )


async def _service_not_found(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ServiceNotFound)
    return _envelope(404, ErrorBody(code="service_not_found", message=str(exc)))


async def _date_out_of_range(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, DateOutsideBookingWindow)
    return _envelope(422, ErrorBody(code="date_out_of_range", message=str(exc)))


# Domain errors that map to a fixed status and code. Their messages are fixed strings that
# never carry submitted values, so they are safe to return as-is.
_DOMAIN_ERRORS: dict[type[DomainError], tuple[int, str]] = {
    SlotNotOffered: (422, "slot_not_offered"),
    SlotUnavailable: (409, "slot_unavailable"),
    ProposalInvalid: (422, "proposal_invalid"),
    ProposalExpired: (422, "proposal_expired"),
    ProposalStale: (409, "proposal_stale"),
    AppointmentNotFound: (404, "appointment_not_found"),
    AgentUnavailable: (503, "agent_unavailable"),
    ConversationNotFound: (404, "conversation_not_found"),
    ConversationExpired: (410, "conversation_expired"),
    IdempotencyKeyReused: (409, "idempotency_key_reused"),
    TurnInProgress: (409, "turn_in_progress"),
    ConversationBusy: (409, "conversation_busy"),
    TurnOutOfOrder: (409, "turn_out_of_order"),
    ConversationLimitReached: (409, "conversation_limit_reached"),
    AgentBusy: (429, "agent_busy"),
    AudioTooLarge: (413, "audio_too_large"),
    AudioUnsupported: (415, "audio_unsupported"),
    AudioInvalid: (422, "audio_invalid"),
    NoSpeech: (422, "no_speech"),
    SpeechBusy: (429, "speech_busy"),
    TranscriptionFailed: (502, "transcription_failed"),
    SpeechUnavailable: (503, "speech_unavailable"),
    TranscriptionTimeout: (504, "transcription_timeout"),
}


def _domain_error_handler(status_code: int, code: str) -> ExceptionHandler:
    async def handler(request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, DomainError)
        # Audit trail: the outcome code and the route template only, never a token, a
        # submitted id or any other submitted value (the template has `{appointment_id}`,
        # not the id that was requested).
        route = getattr(request.scope.get("route"), "path", "-")
        logger.info("domain_error code=%s method=%s route=%s", code, request.method, route)
        retry_after = getattr(exc, "retry_after_s", None)
        headers = {"Retry-After": str(retry_after)} if retry_after is not None else None
        return _envelope(status_code, ErrorBody(code=code, message=str(exc)), headers)

    return handler


async def _storage_unavailable(_: Request, exc: Exception) -> JSONResponse:
    # No traceback and no detail: the adapter already reduced the failure to a fixed message.
    assert isinstance(exc, StorageUnavailable)
    return _envelope(503, ErrorBody(code="storage_unavailable", message=str(exc)))


async def _validation_error(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)
    # Report where and what kind of problem, never the submitted value.
    details = [
        ErrorFieldDetail(loc=[str(part) for part in err["loc"]], issue=err["type"])
        for err in exc.errors()
    ]
    return _envelope(
        422,
        ErrorBody(code="validation_error", message="The request was invalid.", details=details),
    )


_HTTP_ERROR_CODES = {404: "not_found", 405: "method_not_allowed"}


async def _http_error(_: Request, exc: Exception) -> JSONResponse:
    # Router-level errors (unknown path, wrong method) get the same envelope as route errors.
    assert isinstance(exc, StarletteHTTPException)
    code = _HTTP_ERROR_CODES.get(exc.status_code, "http_error")
    return _envelope(
        exc.status_code, ErrorBody(code=code, message=HTTPStatus(exc.status_code).phrase)
    )


async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
    # Log the traceback server-side; the client only ever sees a generic message. The route
    # template is logged, never the concrete path, which can carry an appointment id.
    route = getattr(request.scope.get("route"), "path", "-")
    logger.error("Unhandled error on %s %s", request.method, route, exc_info=exc)
    return _envelope(500, ErrorBody(code="internal_error", message="Something went wrong."))


def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ServiceNotFound, _service_not_found)
    app.add_exception_handler(DateOutsideBookingWindow, _date_out_of_range)
    for error_type, (status_code, code) in _DOMAIN_ERRORS.items():
        app.add_exception_handler(error_type, _domain_error_handler(status_code, code))
    app.add_exception_handler(StorageUnavailable, _storage_unavailable)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_exception_handler(Exception, _unhandled)
