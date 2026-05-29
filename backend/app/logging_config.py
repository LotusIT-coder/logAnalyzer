"""Structured JSON logging via structlog."""
from __future__ import annotations

import logging
import os
import sys
import uuid
from logging.handlers import RotatingFileHandler
from pathlib import Path

import structlog
from starlette.datastructures import MutableHeaders
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send


def configure_logging(json_logs: bool = True, log_dir: str | None = None) -> None:
    processors = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
    ]
    if json_logs:
        processors.append(structlog.processors.JSONRenderer())
    else:
        processors.append(structlog.dev.ConsoleRenderer())

    # Ensure log directory exists if specified
    if log_dir:
        log_path = Path(log_dir)
        if not log_path.is_absolute():
            log_path = Path(__file__).resolve().parents[1] / log_path
        log_dir = str(log_path)
        os.makedirs(log_dir, mode=0o755, exist_ok=True)
        log_file = os.path.join(log_dir, "app.log")
        # Configure file handler with rotation (10MB per file, keep 5 backups)
        file_handler = RotatingFileHandler(
            log_file,
            maxBytes=10 * 1024 * 1024,  # 10MB
            backupCount=5,
        )
        file_handler.setFormatter(logging.Formatter())
        root_logger = logging.getLogger()
        root_logger.addHandler(file_handler)
        root_logger.setLevel(logging.DEBUG)

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(logging.DEBUG),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(sys.stdout),
        cache_logger_on_first_use=True,
    )

    # Filter uvicorn's per-request access log: keep only 4xx/5xx; suppress
    # successful 2xx/3xx (our RequestLoggingMiddleware already records them
    # structured). Keeps client/server errors visible.
    class _AccessLogErrorOnlyFilter(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:
            args = record.args
            try:
                # Uvicorn access format args: (client_addr, method, full_path, http_version, status_code)
                if isinstance(args, tuple) and len(args) >= 5:
                    status = int(args[4])
                    return status >= 400
            except (ValueError, TypeError, IndexError):
                pass
            return True

    access_logger = logging.getLogger("uvicorn.access")
    access_logger.addFilter(_AccessLogErrorOnlyFilter())


class RequestLoggingMiddleware:
    """Attaches trace_id to each HTTP request and logs method/path/status."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive=receive)
        trace_id = str(uuid.uuid4())
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(trace_id=trace_id)

        logger = structlog.get_logger()
        query_string = request.url.query or None
        logger.info(
            "request_started",
            method=request.method,
            path=request.url.path,
            query_string=query_string,
        )

        logged_finished = False

        async def send_wrapper(message: Message) -> None:
            nonlocal logged_finished

            if message.get("type") == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["X-Trace-Id"] = trace_id
                logger.info(
                    "request_finished",
                    method=request.method,
                    path=request.url.path,
                    query_string=query_string,
                    status_code=message.get("status"),
                )
                logged_finished = True

            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            if not logged_finished:
                logger.info(
                    "request_finished",
                    method=request.method,
                    path=request.url.path,
                    query_string=query_string,
                    status_code=500,
                )
            raise
