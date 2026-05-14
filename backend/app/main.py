"""FastAPI application factory."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.ai.model_validation import is_ollama_model_available
from app.api.v1.router import router as v1_router
from app.config import get_settings
from app.db.session import get_engine
from app.errors import http_exception_handler, unhandled_exception_handler
from app.ingestion.watcher import WatcherService
from app.logging_config import RequestLoggingMiddleware, configure_logging
from app.services.rule_scheduler import RuleSchedulerService
from app.services.soc_analyst import SOCAnalystService
from app.services.soc_analyst_runtime import load_soc_analyst_runtime_state


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

    runtime_state = load_soc_analyst_runtime_state(settings.soc_analyst_enabled)
    runtime_source_ids = list(dict.fromkeys(runtime_state.get("source_ids") or []))
    app.state.soc_analyst_enabled = bool(runtime_state.get("enabled", settings.soc_analyst_enabled))
    app.state.soc_analyst_source_ids = runtime_source_ids

    # Start SOC analyst (optional – can be toggled at runtime via API)
    soc_analyst: SOCAnalystService | None = None
    if app.state.soc_analyst_enabled:
        model_ok, installed_models = await is_ollama_model_available(settings.soc_analyst_model)
        if not model_ok:
            app.state.soc_analyst_enabled = False
            app.state.soc_analyst = None
            logger.warning(
                "soc_analyst_model_unavailable",
                configured_model=settings.soc_analyst_model,
                installed_models=installed_models,
            )
        else:
            soc_analyst = SOCAnalystService(
                model=settings.soc_analyst_model,
                interval_seconds=settings.soc_analyst_interval_seconds,
                confidence_threshold=settings.soc_analyst_confidence_threshold,
                window_events=settings.soc_analyst_window_events,
                source_ids=runtime_source_ids,
            )
            app.state.soc_analyst = soc_analyst
            await soc_analyst.start()
            logger.info(
                "soc_analyst_started",
                model=settings.soc_analyst_model,
                interval=settings.soc_analyst_interval_seconds,
                source_ids=runtime_source_ids,
            )
    else:
        app.state.soc_analyst = None
        logger.info("soc_analyst_disabled")

    yield

    logger.info("app_shutdown")
    await watcher.stop()
    await rule_scheduler.stop()
    running_soc = getattr(app.state, "soc_analyst", None)
    if running_soc is not None:
        await running_soc.stop()
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
