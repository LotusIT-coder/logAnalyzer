"""Sources endpoints – GET/POST /api/v1/sources, PATCH /{id}, POST /{id}/test, GET /{id}/tail."""
from __future__ import annotations

import asyncio
import os

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app.db.session import get_session_factory
from app.domain.models import Source, SourceIngestionStatus
from app.schemas.source import (
    SourceCreateRequest,
    SourceIngestionStatusListResponse,
    SourceIngestionStatusResponse,
    SourceListResponse,
    SourcePatchRequest,
    SourceResponse,
    SourceTestResponse,
)
from app.services import source_service
from app.services.source_status import refresh_source_status
from app.services.source_service import DuplicateSourceNameError

router = APIRouter(prefix="/sources", tags=["Sources"])
_TAILABLE_PATH_SOURCE_TYPES = {"file", "syslog", "docker", "filebeat", "winlogbeat", "elastic_agent"}


async def _select_source_status_rows(session: AsyncSession, ids: list[str] | None):
    stmt = (
        select(
            Source.id,
            SourceIngestionStatus.last_ingested_at,
            SourceIngestionStatus.last_event_timestamp,
            SourceIngestionStatus.last_event_created_at,
            SourceIngestionStatus.last_seen_at,
            SourceIngestionStatus.events_per_min,
            SourceIngestionStatus.parse_error_count,
        )
        .outerjoin(SourceIngestionStatus, SourceIngestionStatus.source_id == Source.id)
        .order_by(Source.created_at)
    )
    if ids is not None:
        stmt = stmt.where(Source.id.in_(ids))
    result = await session.execute(stmt)
    return list(result)


@router.get("/status", response_model=SourceIngestionStatusListResponse)
async def source_status(
    source_ids: str | None = None,
    session: AsyncSession = Depends(get_db),
):
    ids: list[str] | None = None
    if source_ids:
        ids = [value.strip() for value in source_ids.split(",") if value.strip()]

    if ids is not None:
        if not ids:
            return SourceIngestionStatusListResponse(items=[])

    rows = await _select_source_status_rows(session, ids)
    missing_source_ids = [str(row.id) for row in rows if row.last_ingested_at is None]
    if missing_source_ids:
        for source_id in missing_source_ids:
            await refresh_source_status(session, source_id)
        await session.commit()
        rows = await _select_source_status_rows(session, ids)

    items = [
        SourceIngestionStatusResponse(
            source_id=str(row.id),
            last_ingested_at=row.last_ingested_at,
            last_event_timestamp=row.last_event_timestamp,
            last_event_created_at=row.last_event_created_at,
            last_seen_at=row.last_seen_at,
            events_per_min=int(row.events_per_min or 0),
            parse_error_count=int(row.parse_error_count or 0),
        )
        for row in rows
    ]
    return SourceIngestionStatusListResponse(items=items)


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
        if source.type in _TAILABLE_PATH_SOURCE_TYPES:
            resolved_path, resolve_err = source_service.resolve_source_path(source)
        elif source.type == "journald":
            resolved_path, resolve_err = "", None
        else:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Live-tail only supported for path-based and journald sources.")
    # Session is now closed — the generators below are stream-only.
    if source.type in _TAILABLE_PATH_SOURCE_TYPES:
        if resolve_err or not resolved_path:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=resolve_err or "File not found.")
        if not os.access(resolved_path, os.R_OK):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"File not readable: {resolved_path}")

    def _build_journald_tail_command() -> list[str]:
        cfg = source.config_json or {}
        command = ["journalctl", "--no-pager", "--output=short-iso"]
        unit = cfg.get("unit")
        if isinstance(unit, str) and unit.strip():
            command.extend(["-u", unit.strip()])
        command.extend(["-n", str(lines), "-f"])
        return command

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

    async def _journald_generator():
        command = _build_journald_tail_command()
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            if process.stdout is None:
                yield "data: [Fehler: journalctl stdout nicht verfuegbar]\n\n"
                return

            while True:
                if await request.is_disconnected():
                    break
                try:
                    line = await asyncio.wait_for(process.stdout.readline(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

                if not line:
                    if process.returncode is not None:
                        break
                    continue

                escaped = line.decode("utf-8", errors="replace").rstrip("\n").replace("\n", " ")
                if escaped:
                    yield f"data: {escaped}\n\n"
        finally:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    process.kill()

    return StreamingResponse(
        _generator() if source.type in _TAILABLE_PATH_SOURCE_TYPES else _journald_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
