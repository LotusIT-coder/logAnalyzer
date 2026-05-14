"""System endpoints: /health and /version."""
from __future__ import annotations

import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.model_validation import is_ollama_model_available
from app.api.source_filters import resolve_source_ids
from app.dependencies import get_db

from app.config import get_settings
from app.domain.models import Incident
from app.services.soc_analyst import SOCAnalystService
from app.services.soc_analyst_runtime import save_soc_analyst_runtime_state

router = APIRouter(tags=["System"])

_start_time = time.monotonic()


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


@router.get("/health")
async def health(request: Request):
    ollama_available = getattr(request.app.state, "ollama_available", False)
    return {
        "status": "ok",
        "uptime_seconds": int(time.monotonic() - _start_time),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "ollama_available": ollama_available,
    }


@router.get("/version")
async def version():
    s = get_settings()
    return {
        "api_version": "1.0.0",
        "app_version": s.app_version,
        "build_commit": s.build_commit,
    }


@router.get("/system/soc-analyst")
async def soc_analyst_status(request: Request):
    return _build_soc_status_payload(request)


@router.put("/system/soc-analyst")
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
    normalized_source_ids = list(dict.fromkeys(resolved_source_ids or []))

    if body.enabled:
        model_ok, installed_models = await is_ollama_model_available(settings.soc_analyst_model)
        if not model_ok:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "message": "Configured SOC_ANALYST_MODEL is not installed in Ollama.",
                    "configured_model": settings.soc_analyst_model,
                    "installed_models": installed_models,
                },
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


@router.post("/system/soc-analyst/demo-alert")
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
