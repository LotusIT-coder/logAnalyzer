"""Unified error response format for the API."""
from __future__ import annotations

import uuid
from typing import Any

import structlog
from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


def _error_body(code: str, message: str, details: Any = None, trace_id: str | None = None) -> dict:
    body: dict = {"code": code, "message": message}
    if details is not None:
        body["details"] = details
    body["trace_id"] = trace_id or str(uuid.uuid4())
    return body


async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    trace_id = request.headers.get("X-Trace-Id", str(uuid.uuid4()))
    return JSONResponse(
        status_code=exc.status_code,
        content=_error_body(
            code=f"HTTP_{exc.status_code}",
            message=exc.detail or "An error occurred.",
            trace_id=trace_id,
        ),
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    trace_id = request.headers.get("X-Trace-Id", str(uuid.uuid4()))
    logger = structlog.get_logger()
    logger.exception("unhandled_exception", trace_id=trace_id, path=request.url.path)
    return JSONResponse(
        status_code=500,
        content=_error_body(
            code="INTERNAL_SERVER_ERROR",
            message="An unexpected error occurred.",
            trace_id=trace_id,
        ),
    )
