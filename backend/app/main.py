"""FastAPI application factory."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.v1.router import router as v1_router
from app.config import get_settings
from app.db.session import get_engine
from app.errors import http_exception_handler, unhandled_exception_handler
from app.ingestion.watcher import WatcherService
from app.logging_config import RequestLoggingMiddleware, configure_logging
from app.services.rule_scheduler import RuleSchedulerService


async def check_ollama_available(settings) -> bool:
    """Check if Ollama binary exists and is accessible at configured path."""
    logger = structlog.get_logger()
    ollama_path = settings.ollama_path
    is_available = os.path.isfile(ollama_path) and os.access(ollama_path, os.X_OK)
    logger.info("ollama_check", available=is_available, path=ollama_path)
    return is_available


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(json_logs=settings.is_production, log_dir=settings.log_dir)
    logger = structlog.get_logger()
    logger.info("app_startup", version=settings.app_version, environment=settings.app_env)

    # Check Ollama availability
    app.state.ollama_available = await check_ollama_available(settings)

    # Warm up DB connection pool
    engine = get_engine()
    async with engine.connect():
        pass
    logger.info("database_connected")

    # Start ingestion watcher
    watcher = WatcherService(interval_seconds=settings.watcher_interval_seconds)
    app.state.watcher = watcher
    await watcher.start()
    logger.info("watcher_started", interval=settings.watcher_interval_seconds)

    # Start rule evaluation scheduler
    rule_scheduler = RuleSchedulerService(interval_seconds=settings.rule_scheduler_interval_seconds)
    app.state.rule_scheduler = rule_scheduler
    await rule_scheduler.start()
    logger.info("rule_scheduler_started", interval=settings.rule_scheduler_interval_seconds)

    yield

    logger.info("app_shutdown")
    await watcher.stop()
    await rule_scheduler.stop()
    await engine.dispose()


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="Log Analyzer API",
        version="1.0.0",
        docs_url="/api/docs" if not settings.is_production else None,
        redoc_url="/api/redoc" if not settings.is_production else None,
        lifespan=lifespan,
    )

    # CORS – allow only explicitly configured origins
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "Accept"],
    )

    app.add_middleware(RequestLoggingMiddleware)

    # Error handlers
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)

    # Routers
    app.include_router(v1_router)

    return app


app = create_app()
