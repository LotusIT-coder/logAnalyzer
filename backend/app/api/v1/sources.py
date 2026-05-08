"""Sources endpoints – GET/POST /api/v1/sources, PATCH /{id}, POST /{id}/test, GET /{id}/tail."""
from __future__ import annotations

import asyncio
import os

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app.db.session import get_session_factory
from app.schemas.source import (
    SourceCreateRequest,
    SourceListResponse,
    SourcePatchRequest,
    SourceResponse,
    SourceTestResponse,
)
from app.services import source_service
from app.services.source_service import DuplicateSourceNameError

router = APIRouter(prefix="/sources", tags=["Sources"])


@router.get("", response_model=SourceListResponse)
async def list_sources(
    session: AsyncSession = Depends(get_db),
):
    sources = await source_service.list_sources(session)
    return SourceListResponse(
        items=[SourceResponse.model_validate(s) for s in sources]
    )


@router.post("", response_model=SourceResponse, status_code=status.HTTP_201_CREATED)
async def create_source(
    body: SourceCreateRequest,
    session: AsyncSession = Depends(get_db),
):
    try:
        source = await source_service.create_source(session, body)
    except DuplicateSourceNameError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Eine Quelle mit dem Namen '{body.name}' existiert bereits.")
    return SourceResponse.model_validate(source)


@router.patch("/{source_id}", response_model=SourceResponse)
async def patch_source(
    source_id: str,
    body: SourcePatchRequest,
    session: AsyncSession = Depends(get_db),
):
    source = await source_service.get_source(session, source_id)
    if source is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source not found.")
    updated = await source_service.patch_source(session, source, body)
    return SourceResponse.model_validate(updated)


@router.delete("/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_source(
    source_id: str,
    session: AsyncSession = Depends(get_db),
):
    source = await source_service.get_source(session, source_id)
    if source is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source not found.")
    await source_service.delete_source(session, source)


@router.post("/{source_id}/test", response_model=SourceTestResponse)
async def test_source(
    source_id: str,
    session: AsyncSession = Depends(get_db),
):
    source = await source_service.get_source(session, source_id)
    if source is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source not found.")
    ok, details = source_service.test_source(source)
    return SourceTestResponse(ok=ok, details=details)


@router.get("/{source_id}/tail")
async def tail_source(
    source_id: str,
    request: Request,
    lines: int = 50,
):
    """Server-Sent Events stream that tails the source file in real-time.

    Sends the last `lines` lines on connect, then streams new lines as they appear.
    Each SSE event has the form: ``data: <raw log line>\\n\\n``
    """
    # Use a short-lived session only for the source lookup so that no DB
    # connection is held open for the duration of the (potentially long-lived)
    # SSE connection.
    factory = get_session_factory()
    async with factory() as session:
        source = await source_service.get_source(session, source_id)
        if source is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source not found.")
        if source.type != "file":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Live-tail only supported for file sources.")
        resolved_path, resolve_err = source_service.resolve_source_path(source)
    # Session is now closed — the generator below is purely file-based.
    if resolve_err or not resolved_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=resolve_err or "File not found.")
    if not os.access(resolved_path, os.R_OK):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"File not readable: {resolved_path}")

    async def _generator():
        active_path = resolved_path
        regex_mode = source_service.source_path_is_regex(source)

        # --- send last N lines on connect ---
        try:
            with open(active_path, "r", errors="replace") as fh:
                all_lines = fh.readlines()
                tail_lines = all_lines[-lines:] if len(all_lines) > lines else all_lines
                for line in tail_lines:
                    escaped = line.rstrip("\n").replace("\n", " ")
                    yield f"data: {escaped}\n\n"
                pos = fh.tell()
        except OSError:
            yield "data: [Fehler: Datei nicht lesbar]\n\n"
            return

        # --- then follow new lines ---
        while True:
            if await request.is_disconnected():
                break
            if regex_mode:
                latest_path, _ = source_service.resolve_source_path(source)
                if latest_path and latest_path != active_path:
                    active_path = latest_path
                    pos = 0
            try:
                with open(active_path, "r", errors="replace") as fh:
                    fh.seek(0, 2)
                    new_size = fh.tell()
                    if new_size < pos:
                        # file was rotated
                        pos = 0
                    if new_size > pos:
                        fh.seek(pos)
                        new_lines = fh.readlines()
                        pos = fh.tell()
                        for line in new_lines:
                            escaped = line.rstrip("\n").replace("\n", " ")
                            yield f"data: {escaped}\n\n"
            except OSError:
                break
            await asyncio.sleep(1)

    return StreamingResponse(
        _generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
