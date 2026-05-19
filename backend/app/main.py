"""FastAPI application factory."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.ai.model_validation import is_ollama_model_available
from app.api.v1.router import router as v1_router
from app.config import get_settings
from app.db.session import get_engine, get_session_factory
from app.domain.models import Source
from app.errors import http_exception_handler, unhandled_exception_handler
from app.ingestion.watcher import WatcherService
from app.logging_config import RequestLoggingMiddleware, configure_logging
from app.services.elastic_client import ElasticClient
from app.services.elastic_indexer import ElasticIndexerService
from app.services.event_bus import InMemoryEventBus
from app.services.rule_scheduler import RuleSchedulerService
from app.services.ai_auto_triage import (
    AUTO_TRIAGE_EVENT_TOPIC,
    _handle_auto_triage_requested,
    configure_auto_triage_event_bus,
)
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

    # Optional Elasticsearch integration (secondary store)
    app.state.elastic_enabled = settings.elastic_enabled
    app.state.elastic_available = False
    app.state.elastic_bootstrap_ok = False
    if settings.elastic_enabled:
        elastic = ElasticClient.from_settings(settings)
        app.state.elastic_available = await elastic.ping()
        if app.state.elastic_available:
            app.state.elastic_bootstrap_ok = await elastic.ensure_bootstrap(
                ilm_policy_name=settings.elastic_ilm_policy_name,
                index_template_name=settings.elastic_index_template_name,
                index_pattern=settings.elastic_index_pattern,
            )
        else:
            logger.warning("elastic_unavailable", elastic_url=settings.elastic_url)
    else:
        logger.info("elastic_disabled")

    app.state.elastic_indexer = None
    if settings.elastic_enabled and settings.elastic_indexer_enabled:
        elastic_indexer = ElasticIndexerService(
            interval_seconds=settings.elastic_indexer_interval_seconds,
            batch_size=settings.elastic_indexer_batch_size,
        )
        app.state.elastic_indexer = elastic_indexer
        await elastic_indexer.start()
    else:
        logger.info("elastic_indexer_disabled")

    # Warm up DB connection pool
    engine = get_engine()
    async with engine.connect():
        pass
    logger.info("database_connected")

    # Start internal event bus (local async queue, broker-compatible API).
    event_bus = InMemoryEventBus(
        workers=settings.event_bus_workers,
        queue_size=settings.event_bus_queue_size,
        max_retry_attempts=settings.event_bus_max_retry_attempts,
        retry_backoff_seconds=settings.event_bus_retry_backoff_seconds,
        dead_letter_max=settings.event_bus_dead_letter_max,
    )
    event_bus.subscribe(AUTO_TRIAGE_EVENT_TOPIC, _handle_auto_triage_requested)
    await event_bus.start()
    configure_auto_triage_event_bus(event_bus)
    app.state.event_bus = event_bus
    logger.info("event_bus_ready", **event_bus.get_stats())

    # Start ingestion watcher
    watcher = WatcherService(
        interval_seconds=settings.watcher_interval_seconds,
        catchup_min_sleep_seconds=settings.watcher_catchup_min_sleep_seconds,
    )
    app.state.watcher = watcher
    await watcher.start()
    logger.info(
        "watcher_started",
        interval=settings.watcher_interval_seconds,
        catchup_min_sleep=settings.watcher_catchup_min_sleep_seconds,
    )

    # Start rule evaluation scheduler
    rule_scheduler = RuleSchedulerService(interval_seconds=settings.rule_scheduler_interval_seconds)
    app.state.rule_scheduler = rule_scheduler
    await rule_scheduler.start()
    logger.info("rule_scheduler_started", interval=settings.rule_scheduler_interval_seconds)

    runtime_state = load_soc_analyst_runtime_state(settings.soc_analyst_enabled)
    runtime_source_ids = list(dict.fromkeys(runtime_state.get("source_ids") or []))
    if runtime_source_ids:
        session_factory = get_session_factory()
        async with session_factory() as session:
            existing_source_ids = {
                str(value)
                for value in (
                    await session.execute(
                        select(Source.id).where(Source.id.in_(runtime_source_ids))
                    )
                ).scalars().all()
            }
        # If runtime state references only stale IDs (e.g. recreated demo
        # sources), fall back to monitoring all sources automatically.
        if not existing_source_ids:
            runtime_source_ids = []
    app.state.soc_analyst_enabled = bool(runtime_state.get("enabled", settings.soc_analyst_enabled))
    app.state.soc_analyst_source_ids = runtime_source_ids

    # Start SOC analyst (optional – can be toggled at runtime via API)
    soc_analyst: SOCAnalystService | None = None
    if app.state.soc_analyst_enabled:
        try:
            model_ok, installed_models = await is_ollama_model_available(settings.soc_analyst_model)
        except Exception:
            app.state.soc_analyst_enabled = False
            app.state.soc_analyst = None
            logger.warning(
                "soc_analyst_model_check_failed",
                configured_model=settings.soc_analyst_model,
                exc_info=True,
            )
            model_ok, installed_models = False, []
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
    running_indexer = getattr(app.state, "elastic_indexer", None)
    if running_indexer is not None:
        await running_indexer.stop()
    running_bus = getattr(app.state, "event_bus", None)
    if running_bus is not None:
        await running_bus.stop(drain=True, drain_timeout_seconds=settings.event_bus_drain_timeout_seconds)
    configure_auto_triage_event_bus(None)
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
