"""Events endpoints – GET /events, GET /events/{id}, GET /events/stream.

SSE stream endpoint emits new events by polling every second (MVP implementation).
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import AsyncGenerator, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.source_filters import resolve_source_ids
from app.db.session import get_session_factory
from app.dependencies import get_db
from app.domain.models import Event
from app.schemas.event import EventListResponse, EventResponse
from app.services.event_search import EventSearchQuery, EventSearchResult, search_events_elastic, search_events_postgres

router = APIRouter(prefix="/events", tags=["Events"])

_STREAM_POLL_LIMIT = 500


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _is_short_realtime_window(query: EventSearchQuery) -> bool:
    if query.from_ts is None:
        return False
    upper_bound = _as_utc(query.to_ts) if query.to_ts is not None else datetime.now(timezone.utc)
    lower_bound = _as_utc(query.from_ts)
    return (upper_bound - lower_bound) <= timedelta(minutes=5)


def _should_fallback_to_postgres_for_freshness(query: EventSearchQuery, result: EventSearchResult) -> bool:
    """Detect likely stale Elastic reads for short near-real-time windows.

    For very short windows (<= 5 min), empty or clearly outdated hits are
    usually caused by indexing lag. In that case we switch to PostgreSQL,
    which is the ingestion source of truth.
    """
    if query.from_ts is None:
        return False

    upper_bound = _as_utc(query.to_ts) if query.to_ts is not None else datetime.now(timezone.utc)
    lower_bound = _as_utc(query.from_ts)
    window = upper_bound - lower_bound
    if window > timedelta(minutes=5):
        return False

    if not result.items:
        return True

    freshest_created = max((_as_utc(item.created_at) for item in result.items), default=None)
    if freshest_created is None:
        return True

    return freshest_created < (upper_bound - timedelta(minutes=1))


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
):
    """Server-Sent Events stream. Polls the DB every second for new events.

    A fresh DB session is opened and closed on every poll tick so that no
    connection is held open for the full lifetime of the SSE connection.
    """
    factory = get_session_factory()

    async def _generator() -> AsyncGenerator[str, None]:
        # Bootstrap: record which event IDs already exist so we only emit future ones.
        async with factory() as session:
            seen_event_ids = await _stream_start_seen_ids(session, event_type)

        while True:
            if await request.is_disconnected():
                break

            async with factory() as session:
                result = await session.execute(_stream_events_stmt(event_type))
                rows = list(reversed(result.scalars().all()))

            for row in rows:
                if row.id in seen_event_ids:
                    continue
                data = EventResponse.model_validate(row).model_dump(by_alias=False)
                # datetime objects must be serialized manually
                yield f"data: {json.dumps(data, default=str)}\n\n"
                seen_event_ids.add(row.id)

            # Trim the seen-IDs set so it doesn't grow without bound.
            if len(seen_event_ids) > _STREAM_POLL_LIMIT * 4:
                async with factory() as session:
                    seen_event_ids = await _stream_start_seen_ids(session, event_type)

            await asyncio.sleep(1)

    return StreamingResponse(_generator(), media_type="text/event-stream")


@router.get("", response_model=EventListResponse)
async def list_events(
    request: Request,
    response: Response,
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
    provider: Optional[str] = Query(None),
):
    provider_mode = (provider or "auto").strip().lower()
    if provider_mode not in {"auto", "postgres", "elastic"}:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="provider must be auto, postgres, or elastic")

    resolved_source_ids = await resolve_source_ids(session, source_id, source_ids, source_paths)
    if resolved_source_ids == []:
        response.headers["X-Events-Provider"] = "none"
        return EventListResponse(items=[], next_cursor=None)

    query = EventSearchQuery(
        from_ts=from_,
        to_ts=to,
        resolved_source_ids=resolved_source_ids,
        severity=severity,
        service=service,
        host=host,
        q=q,
        limit=limit,
        cursor=cursor,
    )
    short_realtime_window = _is_short_realtime_window(query)
    if short_realtime_window:
        query.use_created_at_window_only = True

    elastic_available = bool(getattr(request.app.state, "elastic_available", False))
    if provider_mode == "postgres":
        result = await search_events_postgres(session, query)
    elif provider_mode == "elastic":
        try:
            result = await search_events_elastic(session, query, elastic_is_available=elastic_available)
        except RuntimeError as exc:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    else:
        if short_realtime_window:
            result = await search_events_postgres(session, query)
            response.headers["X-Events-Provider"] = result.provider_used
            return EventListResponse(items=result.items, next_cursor=result.next_cursor)
        try:
            result = await search_events_elastic(session, query, elastic_is_available=elastic_available)
            if _should_fallback_to_postgres_for_freshness(query, result):
                result = await search_events_postgres(session, query)
        except Exception:
            result = await search_events_postgres(session, query)

    response.headers["X-Events-Provider"] = result.provider_used
    return EventListResponse(items=result.items, next_cursor=result.next_cursor)


@router.get("/{event_id}", response_model=EventResponse)
async def get_event(
    event_id: str,
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(Event).where(Event.id == event_id))
    event = result.scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found.")
    return EventResponse.model_validate(event)
