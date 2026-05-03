"""v1 API router – aggregates all endpoint modules."""
from __future__ import annotations

from fastapi import APIRouter

from app.api.v1 import (
    ai, audit, auth, events, incidents, ingestion, metrics,
    model_profiles, parser, parser_profiles, rules, sources, system, upload,
)

router = APIRouter(prefix="/api/v1")

router.include_router(system.router)
router.include_router(sources.router)
router.include_router(auth.router)
router.include_router(ingestion.router)
router.include_router(parser.router)
router.include_router(parser_profiles.router)
router.include_router(events.router)
router.include_router(rules.router)
router.include_router(incidents.router)
router.include_router(ai.router)
router.include_router(model_profiles.router)
router.include_router(metrics.router)
router.include_router(audit.router)
router.include_router(upload.router)
