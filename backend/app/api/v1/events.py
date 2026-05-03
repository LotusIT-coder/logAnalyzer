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

from app.auth import require_scope
from app.dependencies import get_db
from app.domain.models import Event
from app.schemas.event import EventListResponse, EventResponse

router = APIRouter(prefix="/events", tags=["Events"])

_read = Depends(require_scope("read"))


@router.get("/stream")
async def stream_events(
    request: Request,
    _token=_read,
    session: AsyncSession = Depends(get_db),
):
    """Server-Sent Events stream. Emits new events every second."""

    async def _generator() -> AsyncGenerator[str, None]:
        last_seen_created_at: Optional[datetime] = None
        while True:
            if await request.is_disconnected():
                break

            stmt = select(Event).order_by(Event.created_at.asc()).limit(50)
            if last_seen_created_at is not None:
                stmt = stmt.where(Event.created_at > last_seen_created_at)

            result = await session.execute(stmt)
            rows = result.scalars().all()

            for row in rows:
                data = EventResponse.model_validate(row).model_dump(by_alias=False)
                # datetime objects must be serialized manually
                yield f"data: {json.dumps(data, default=str)}\n\n"
                last_seen_created_at = row.created_at

            await asyncio.sleep(1)

    return StreamingResponse(_generator(), media_type="text/event-stream")


@router.get("", response_model=EventListResponse)
async def list_events(
    _token=_read,
    session: AsyncSession = Depends(get_db),
    from_: Optional[datetime] = Query(None, alias="from"),
    to: Optional[datetime] = Query(None),
    source_id: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    service: Optional[str] = Query(None),
    host: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    cursor: Optional[str] = Query(None),
):
    stmt = select(Event).order_by(Event.timestamp.desc()).limit(limit + 1)

    if from_:
        stmt = stmt.where(Event.timestamp >= from_)
    if to:
        stmt = stmt.where(Event.timestamp <= to)
    if source_id:
        stmt = stmt.where(Event.source_id == source_id)
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
