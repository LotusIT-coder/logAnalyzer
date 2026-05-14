"""System endpoints: /health and /version."""
from __future__ import annotations

import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.source_filters import resolve_source_ids
from app.dependencies import get_db

from app.config import get_settings
from app.services.soc_analyst import SOCAnalystService
from app.services.soc_analyst_runtime import save_soc_analyst_runtime_state

router = APIRouter(tags=["System"])

_start_time = time.monotonic()


class SOCAnalystToggleRequest(BaseModel):
    enabled: bool
    source_ids: list[str] | None = None
    source_paths: list[str] | None = None


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
