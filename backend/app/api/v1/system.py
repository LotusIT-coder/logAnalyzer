"""System endpoints: /health and /version."""
from __future__ import annotations

import time
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.model_validation import is_ollama_model_available
from app.api.source_filters import resolve_source_ids
from app.dependencies import get_db

from app.config import get_settings
from app.domain.models import Incident, Source, SourceIngestionStatus
from app.services.soc_analyst import SOCAnalystService
from app.services.soc_analyst_runtime import save_soc_analyst_runtime_state

router = APIRouter(tags=["System"])

_start_time = time.monotonic()


async def _check_ollama_api_reachable(base_url: str) -> tuple[bool, str | None]:
    url = f"{base_url.rstrip('/')}/api/tags"
    timeout = httpx.Timeout(connect=1.5, read=2.0, write=2.0, pool=2.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(url)
            if response.status_code >= 400:
                return False, f"HTTP {response.status_code}"
            return True, None
    except Exception as exc:
        return False, str(exc)


class SOCAnalystToggleRequest(BaseModel):
    enabled: bool
    source_ids: list[str] | None = None
    source_paths: list[str] | None = None


class SOCDemoAlertRequest(BaseModel):
    count: int = 1
    title: str = "AI SOC DEMO: Verdaechtiges Aktivitaetsmuster erkannt"
    severity: str = "critical"
    summary: str = "Mehrere fehlgeschlagene Anmeldungen und Muster wie Brute-Force wurden als verdachtig eingestuft."


def _build_soc_status_payload(request: Request) -> dict:
    service = getattr(request.app.state, "soc_analyst", None)
    source_ids = getattr(request.app.state, "soc_analyst_source_ids", [])
    enabled = bool(getattr(request.app.state, "soc_analyst_enabled", False))
    return {
        "enabled": enabled,
        "running": bool(service is not None and service.running),
        "source_ids": list(source_ids or []),
        "tick_count": int(getattr(service, "tick_count", 0) if service is not None else 0),
    }


def _build_watcher_status_payload(request: Request) -> dict:
    service = getattr(request.app.state, "watcher", None)
    return {
        "running": bool(service is not None and service.running),
        "tick_count": int(getattr(service, "tick_count", 0) if service is not None else 0),
        "last_tick_lines": int(getattr(service, "last_tick_lines", 0) if service is not None else 0),
        "last_tick_started_at": getattr(service, "_last_tick_started_at", None).isoformat()
        if getattr(service, "_last_tick_started_at", None) is not None
        else None,
        "last_tick_finished_at": getattr(service, "_last_tick_finished_at", None).isoformat()
        if getattr(service, "_last_tick_finished_at", None) is not None
        else None,
        "last_tick_error": getattr(service, "_last_tick_error", None),
    }


def _age_seconds(value: datetime | None, now: datetime) -> int | None:
    if value is None:
        return None
    normalized = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    return max(0, int((now - normalized.astimezone(timezone.utc)).total_seconds()))


@router.get("/health", summary="Service health")
async def health(request: Request):
    settings = get_settings()
    ollama_available = getattr(request.app.state, "ollama_available", False)
    ollama_api_reachable, ollama_api_error = await _check_ollama_api_reachable(settings.ollama_base_url)
    elastic_enabled = bool(getattr(request.app.state, "elastic_enabled", False))
    elastic_available = bool(getattr(request.app.state, "elastic_available", False))
    elastic_bootstrap_ok = bool(getattr(request.app.state, "elastic_bootstrap_ok", False))
    elastic_indexer = getattr(request.app.state, "elastic_indexer", None)
    elastic_indexer_running = bool(elastic_indexer is not None and elastic_indexer.running)
    event_bus = getattr(request.app.state, "event_bus", None)
    event_bus_stats = event_bus.get_stats() if event_bus is not None else None
    watcher_stats = _build_watcher_status_payload(request)
    return {
        "status": "ok",
        "uptime_seconds": int(time.monotonic() - _start_time),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "ollama_available": ollama_available,
        "ollama_base_url": settings.ollama_base_url,
        "ollama_api_reachable": ollama_api_reachable,
        "ollama_api_error": ollama_api_error,
        "elastic_enabled": elastic_enabled,
        "elastic_available": elastic_available,
        "elastic_bootstrap_ok": elastic_bootstrap_ok,
        "elastic_indexer_running": elastic_indexer_running,
        "watcher": watcher_stats,
        "event_bus": event_bus_stats,
    }


@router.get("/version", summary="API version")
async def version():
    s = get_settings()
    return {
        "api_version": "1.0.0",
        "app_version": s.app_version,
        "build_commit": s.build_commit,
    }


@router.get("/system/now", summary="Server time (UTC)")
async def get_server_time():
    """Return current server time in UTC. Used for time-range calculations.
    
    Prevents time-skew bugs where client Date.now() differs from server 
    datetime.now(timezone.utc), causing events to fall outside filter ranges.
    """
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "unix_ms": int(datetime.now(timezone.utc).timestamp() * 1000),
    }


@router.get("/system/soc-analyst", summary="SOC analyst status")
async def soc_analyst_status(request: Request):
    return _build_soc_status_payload(request)


@router.get("/system/ingestion-diagnostics", summary="Ingestion diagnostics")
async def ingestion_diagnostics(session: AsyncSession = Depends(get_db)):
    now = datetime.now(timezone.utc)

    stmt = (
        select(
            Source.id,
            Source.name,
            Source.type,
            Source.enabled,
            SourceIngestionStatus.last_ingested_at,
            SourceIngestionStatus.last_event_timestamp,
            SourceIngestionStatus.last_event_created_at,
            SourceIngestionStatus.events_per_min,
            SourceIngestionStatus.parse_error_count,
        )
        .outerjoin(SourceIngestionStatus, SourceIngestionStatus.source_id == Source.id)
        .order_by(Source.created_at)
    )
    rows = (await session.execute(stmt)).all()

    items: list[dict] = []
    for row in rows:
        freshest_created = row.last_event_created_at
        freshest_ts = row.last_event_timestamp

        items.append(
            {
                "source_id": str(row.id),
                "name": row.name,
                "type": row.type,
                "enabled": bool(row.enabled),
                "status_last_ingested_at": row.last_ingested_at,
                "status_last_event_created_at": freshest_created,
                "status_last_event_timestamp": freshest_ts,
                "freshest_event_created_at": freshest_created,
                "freshest_event_timestamp": freshest_ts,
                "events_per_min": int(row.events_per_min or 0),
                "parse_error_count": int(row.parse_error_count or 0),
                "age_last_ingest_seconds": _age_seconds(row.last_ingested_at, now),
                "age_freshest_created_seconds": _age_seconds(freshest_created, now),
                "age_freshest_timestamp_seconds": _age_seconds(freshest_ts, now),
                "fresh_within_60s": bool((_age_seconds(freshest_created, now) or 10**9) <= 60),
            }
        )

    return {
        "generated_at": now,
        "source_count": len(items),
        "fresh_sources_60s": sum(1 for item in items if item["fresh_within_60s"]),
        "items": items,
    }


@router.put("/system/soc-analyst", summary="Update SOC analyst status")
async def set_soc_analyst_status(
    body: SOCAnalystToggleRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
):
    settings = get_settings()
    current_service: SOCAnalystService | None = getattr(request.app.state, "soc_analyst", None)

    source_ids_csv = ",".join(body.source_ids or []) if body.source_ids else None
    source_paths_csv = ",".join(body.source_paths or []) if body.source_paths else None
    resolved_source_ids = await resolve_source_ids(
        session,
        source_id=None,
        source_ids_csv=source_ids_csv,
        source_paths_csv=source_paths_csv,
    )
    normalized_source_ids = list(
        dict.fromkeys(str(source_id) for source_id in (resolved_source_ids or []) if str(source_id).strip())
    )

    if body.enabled:
        try:
            model_ok, installed_models = await is_ollama_model_available(settings.soc_analyst_model)
        except (httpx.ConnectError, httpx.HTTPError) as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=(
                    "Ollama ist aktuell nicht erreichbar. Bitte Ollama starten/pruefen und erneut versuchen. "
                    f"Details: {exc}"
                ),
            ) from exc

        if not model_ok:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    f"Das konfigurierte SOC-Analyst-Modell '{settings.soc_analyst_model}' ist in Ollama nicht installiert. "
                    f"Installiert: {', '.join(installed_models) if installed_models else 'keine'}"
                ),
            )

        if current_service is not None:
            await current_service.stop()
            current_service = None

        next_service = SOCAnalystService(
            model=settings.soc_analyst_model,
            interval_seconds=settings.soc_analyst_interval_seconds,
            confidence_threshold=settings.soc_analyst_confidence_threshold,
            window_events=settings.soc_analyst_window_events,
            source_ids=normalized_source_ids,
        )
        request.app.state.soc_analyst = next_service
        request.app.state.soc_analyst_enabled = True
        request.app.state.soc_analyst_source_ids = normalized_source_ids
        await next_service.start()
    else:
        if current_service is not None:
            await current_service.stop()
        request.app.state.soc_analyst = None
        request.app.state.soc_analyst_enabled = False
        request.app.state.soc_analyst_source_ids = normalized_source_ids

    save_soc_analyst_runtime_state(bool(body.enabled), normalized_source_ids)
    return _build_soc_status_payload(request)


@router.post("/system/soc-analyst/demo-alert", summary="Create SOC demo alert")
async def create_soc_demo_alert(
    body: SOCDemoAlertRequest,
    session: AsyncSession = Depends(get_db),
):
    count = max(1, min(int(body.count), 10))
    now = datetime.now(timezone.utc)
    created_ids: list[str] = []

    for index in range(count):
        incident = Incident(
            title=f"{body.title} #{index + 1}" if count > 1 else body.title,
            status="open",
            severity=body.severity,
            first_seen=now,
            last_seen=now,
            event_count=1,
            rule_id=None,
            summary=body.summary,
            tags_json=["ai_soc", "demo_soc", "pattern:demo"],
        )
        session.add(incident)
        await session.flush()
        created_ids.append(str(incident.id))

    await session.commit()
    return {
        "created": len(created_ids),
        "incident_ids": created_ids,
    }
