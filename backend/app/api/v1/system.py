"""System endpoints: /health and /version."""
from __future__ import annotations

import time
from datetime import datetime, timezone

from fastapi import APIRouter, Request

from app.config import get_settings

router = APIRouter(tags=["System"])

_start_time = time.monotonic()


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
