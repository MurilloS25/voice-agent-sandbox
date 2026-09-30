from collections.abc import Callable
from datetime import datetime
from typing import Annotated, cast

from fastapi import Depends, Request

from voice_agent_api.domain.ports import AppointmentBook, BusinessCatalog

Clock = Callable[[], datetime]


def get_catalog(request: Request) -> BusinessCatalog:
    return cast(BusinessCatalog, request.app.state.catalog)


def get_appointments(request: Request) -> AppointmentBook:
    return cast(AppointmentBook, request.app.state.appointments)


def get_clock(request: Request) -> Clock:
    return cast(Clock, request.app.state.clock)


CatalogDep = Annotated[BusinessCatalog, Depends(get_catalog)]
AppointmentsDep = Annotated[AppointmentBook, Depends(get_appointments)]
ClockDep = Annotated[Clock, Depends(get_clock)]
