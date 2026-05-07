"""Events endpoints – GET /events, GET /events/{id}, GET /events/stream.

SSE stream endpoint emits new events by polling every second (MVP implementation).
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import AsyncGenerator, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.source_filters import resolve_source_ids
from app.auth import require_scope
from app.dependencies import get_db
from app.domain.models import Event
from app.schemas.event import EventListResponse, EventResponse

router = APIRouter(prefix="/events", tags=["Events"])

_read = Depends(require_scope("read"))
_STREAM_POLL_LIMIT = 500


async def _stream_start_seen_ids(session: AsyncSession, event_type: Optional[str] = None) -> set[str]:
    stmt = select(Event.id)
    if event_type:
        stmt = stmt.where(Event.event_type == event_type)
    result = await session.execute(
        stmt.order_by(Event.created_at.desc(), Event.id.desc()).limit(_STREAM_POLL_LIMIT)
    )
    return set(result.scalars().all())


def _stream_events_stmt(event_type: Optional[str] = None):
    stmt = select(Event)
    if event_type:
        stmt = stmt.where(Event.event_type == event_type)
    return stmt.order_by(Event.created_at.desc(), Event.id.desc()).limit(_STREAM_POLL_LIMIT)


@router.get("/stream")
async def stream_events(
    request: Request,
    event_type: Optional[str] = Query(None),
    _token=_read,
    session: AsyncSession = Depends(get_db),
):
    """Server-Sent Events stream. Emits new events every second."""

    async def _generator() -> AsyncGenerator[str, None]:
        # Start at the current DB time so new subscribers receive future events
        # instead of replaying the oldest backlog first.
        seen_event_ids = await _stream_start_seen_ids(session, event_type)
        while True:
            if await request.is_disconnected():
                break

            result = await session.execute(_stream_events_stmt(event_type))
            rows = list(reversed(result.scalars().all()))

            for row in rows:
                if row.id in seen_event_ids:
                    continue
                data = EventResponse.model_validate(row).model_dump(by_alias=False)
                # datetime objects must be serialized manually
                yield f"data: {json.dumps(data, default=str)}\n\n"
                seen_event_ids.add(row.id)

            if len(seen_event_ids) > _STREAM_POLL_LIMIT * 4:
                seen_event_ids = await _stream_start_seen_ids(session, event_type)

            await asyncio.sleep(1)

    return StreamingResponse(_generator(), media_type="text/event-stream")


@router.get("", response_model=EventListResponse)
async def list_events(
    _token=_read,
    session: AsyncSession = Depends(get_db),
    from_: Optional[datetime] = Query(None, alias="from"),
    to: Optional[datetime] = Query(None),
    source_id: Optional[str] = Query(None),
    source_ids: Optional[str] = Query(None),
    source_paths: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    service: Optional[str] = Query(None),
    host: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    cursor: Optional[str] = Query(None),
):
    resolved_source_ids = await resolve_source_ids(session, source_id, source_ids, source_paths)
    if resolved_source_ids == []:
        return EventListResponse(items=[], next_cursor=None)

    stmt = select(Event).order_by(Event.timestamp.desc()).limit(limit + 1)

    if from_:
        stmt = stmt.where(Event.timestamp >= from_)
    if to:
        stmt = stmt.where(Event.timestamp <= to)
    if resolved_source_ids is not None:
        stmt = stmt.where(Event.source_id.in_(resolved_source_ids))
    if severity:
        stmt = stmt.where(Event.severity == severity)
    if service:
        stmt = stmt.where(Event.service == service)
    if host:
        stmt = stmt.where(Event.host == host)
    if q:
        stmt = stmt.where(Event.message.ilike(f"%{q}%"))
    if cursor:
        # cursor is a timestamp ISO string used as keyset pagination marker
        try:
            cursor_ts = datetime.fromisoformat(cursor)
            stmt = stmt.where(Event.timestamp < cursor_ts)  # DESC: next page goes further back
        except ValueError:
            pass  # ignore invalid cursor – start from beginning

    result = await session.execute(stmt)
    rows = list(result.scalars().all())

    next_cursor: Optional[str] = None
    if len(rows) > limit:
        rows = rows[:limit]
        next_cursor = rows[-1].timestamp.isoformat()

    return EventListResponse(
        items=[EventResponse.model_validate(r) for r in rows],
        next_cursor=next_cursor,
    )


@router.get("/{event_id}", response_model=EventResponse)
async def get_event(
    event_id: str,
    _token=_read,
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(Event).where(Event.id == event_id))
    event = result.scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found.")
    return EventResponse.model_validate(event)
