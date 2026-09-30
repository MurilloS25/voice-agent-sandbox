"""Exception handlers that turn every failure into the structured error envelope."""

import logging
from http import HTTPStatus

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from voice_agent_api.api.schemas import ErrorBody, ErrorFieldDetail, ErrorResponse
from voice_agent_api.domain.errors import DateOutsideBookingWindow, ServiceNotFound

logger = logging.getLogger("voice_agent_api")


def _envelope(status_code: int, body: ErrorBody) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=ErrorResponse(error=body).model_dump(mode="json", exclude_none=True),
    )


async def _service_not_found(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ServiceNotFound)
    return _envelope(404, ErrorBody(code="service_not_found", message=str(exc)))


async def _date_out_of_range(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, DateOutsideBookingWindow)
    return _envelope(422, ErrorBody(code="date_out_of_range", message=str(exc)))


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
    # Log the traceback server-side; the client only ever sees a generic message.
    logger.error("Unhandled error on %s %s", request.method, request.url.path, exc_info=exc)
    return _envelope(500, ErrorBody(code="internal_error", message="Something went wrong."))


def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ServiceNotFound, _service_not_found)
    app.add_exception_handler(DateOutsideBookingWindow, _date_out_of_range)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_exception_handler(Exception, _unhandled)
