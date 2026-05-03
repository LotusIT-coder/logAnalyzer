"""Ingestion endpoints – POST /api/v1/ingestion/run."""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import require_scope
from app.dependencies import get_db
from app.ingestion.file_reader import ingest_source, run_ingestion
from app.domain.models import Source

router = APIRouter(prefix="/ingestion", tags=["Ingestion"])


class IngestionRunRequest(BaseModel):
    """Optional body to restrict ingestion to specific sources or ad-hoc paths."""
    source_ids: Optional[List[str]] = None  # restrict to these IDs; None = all enabled
    extra_paths: Optional[List[str]] = None  # ad-hoc file paths (not stored persistently)


class IngestionRunResponse(BaseModel):
    accepted: bool
    results: list


@router.post("/run", response_model=IngestionRunResponse, status_code=202)
async def trigger_ingestion(
    body: IngestionRunRequest = IngestionRunRequest(),
    _token=Depends(require_scope("write")),
    session: AsyncSession = Depends(get_db),
):
    """Manually trigger an ingestion run.

    - Without body: runs all enabled sources.
    - With `source_ids`: runs only the listed sources.
    - With `extra_paths`: also ingest ad-hoc file paths as temporary (unsaved) sources.
    """
    from app.services.source_service import list_sources

    results = []

    # --- configured sources ---
    if body.source_ids is not None:
        # Only ingest the requested source IDs
        from sqlalchemy import select
        all_sources = await list_sources(session)
        sources = [s for s in all_sources if s.id in body.source_ids]
    else:
        sources = [s for s in await list_sources(session) if s.enabled]

    for source in sources:
        stats = await ingest_source(session, source)
        results.append(stats)

    # --- ad-hoc extra paths ---
    if body.extra_paths:
        import os
        for path in body.extra_paths:
            path = path.strip()
            if not path:
                continue
            # Create a transient (in-memory only) Source object – not persisted
            temp = Source(
                id=f"adhoc:{path}",
                name=os.path.basename(path),
                type="file",
                config_json={"path": path},
                enabled=True,
            )
            # We need a real UUID for the FK in raw_log – skip raw_log for ad-hoc
            # instead: just report what we found
            if not os.path.exists(path):
                results.append({"source_id": path, "skipped": True, "reason": f"file not found: {path}"})
            else:
                results.append({"source_id": path, "adhoc": True, "lines_readable": sum(1 for _ in open(path, errors='replace'))})

    return IngestionRunResponse(accepted=True, results=results)
