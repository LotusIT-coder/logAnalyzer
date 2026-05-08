"""Ingestion endpoints – POST /api/v1/ingestion/run."""
from __future__ import annotations

from typing import List, Literal, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app.ingestion.file_reader import ingest_source, run_ingestion
from app.domain.models import Source

router = APIRouter(prefix="/ingestion", tags=["Ingestion"])


class IngestionRunRequest(BaseModel):
    """Optional body to restrict ingestion to specific sources or ad-hoc paths."""
    class ExtraPath(BaseModel):
        path: str
        origin: Literal["preset", "custom"] = "custom"

    source_ids: Optional[List[str]] = None  # restrict to these IDs; None = all enabled
    extra_paths: Optional[List[str]] = None  # ad-hoc file paths (not stored persistently)
    extra_entries: Optional[List[ExtraPath]] = None  # enriched extra paths with origin


class IngestionRunResponse(BaseModel):
    accepted: bool
    results: list


@router.post("/run", response_model=IngestionRunResponse, status_code=202)
async def trigger_ingestion(
    body: IngestionRunRequest = IngestionRunRequest(),
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
    all_sources = await list_sources(session)
    if body.source_ids is not None:
        # Only ingest the requested source IDs
        sources = [s for s in all_sources if s.id in body.source_ids]
    else:
        sources = [s for s in all_sources if s.enabled]

    for source in sources:
        stats = await ingest_source(session, source)
        results.append(stats)

    # --- extra paths: ensure these are ingested as real (persisted) sources ---
    # Accept legacy extra_paths + enriched extra_entries
    extra_entries: list[tuple[str, str]] = []
    if body.extra_paths:
        extra_entries.extend([(p, "custom") for p in body.extra_paths])
    if body.extra_entries:
        extra_entries.extend([(e.path, e.origin) for e in body.extra_entries])

    if extra_entries:
        import os

        by_path = {
            (s.config_json.get("path") or ""): s
            for s in all_sources
            if s.type == "file" and isinstance(s.config_json, dict)
        }

        for path, origin in extra_entries:
            path = path.strip()
            if not path:
                continue

            if not os.path.exists(path):
                results.append({"source_id": path, "skipped": True, "reason": f"file not found: {path}"})
                continue

            source = by_path.get(path)
            if source is None:
                # First selection of this path: create source once and reuse it afterwards.
                source = Source(
                    name=os.path.basename(path) or path,
                    type="file",
                    config_json={"path": path, "source_origin": origin},
                    enabled=True,
                )
                session.add(source)
                await session.flush()
                await session.refresh(source)
                by_path[path] = source
                all_sources.append(source)
            else:
                # If this path was previously auto-created without origin, backfill origin metadata.
                cfg = dict(source.config_json or {})
                if "source_origin" not in cfg and origin in {"preset", "custom"}:
                    cfg["source_origin"] = origin
                    source.config_json = cfg
                    session.add(source)
                    await session.flush()

            stats = await ingest_source(session, source)
            stats["source_path"] = path
            stats["source_name"] = source.name
            stats["source_origin"] = origin
            results.append(stats)

    return IngestionRunResponse(accepted=True, results=results)
