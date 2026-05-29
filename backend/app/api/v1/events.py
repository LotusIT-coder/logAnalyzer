"""Events endpoints – GET /events, GET /events/{id}, GET /events/stream.

SSE stream endpoint emits new events by polling every second (MVP implementation).
"""
from __future__ import annotations

import asyncio
from collections import deque
import json
from datetime import datetime, timedelta, timezone
from typing import AsyncGenerator, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.source_filters import resolve_source_ids
from app.db.session import get_session_factory
from app.dependencies import get_db
from app.domain.models import Event
from app.schemas.event import EventListResponse, EventResponse
from app.services.event_search import EventSearchQuery, EventSearchResult, search_events_elastic, search_events_postgres

router = APIRouter(prefix="/events", tags=["Events"])

_STREAM_POLL_LIMIT = 500
_STREAM_HEARTBEAT_SECONDS = 10


def _parse_csv(value: Optional[str]) -> list[str]:
    if not value:
        return []
    return [entry.strip() for entry in value.split(",") if entry.strip()]


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


def _encode_stream_cursor(created_at: datetime, event_id: str) -> str:
    return f"{_as_utc(created_at).isoformat()}|{event_id}"

def _decode_stream_cursor(cursor: str) -> tuple[datetime, str] | None:
    if not cursor or "|" not in cursor:
        return None
    ts_raw, event_id = cursor.rsplit("|", 1)
    if not ts_raw or not event_id:
        return None
    try:
        ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _as_utc(ts), event_id


def _apply_stream_filters(
    stmt,
    *,
    resolved_source_ids: Optional[list[str]],
    severities: list[str],
    service: Optional[str],
    host: Optional[str],
    q: Optional[str],
    event_type: Optional[str],
):
    if event_type:
        stmt = stmt.where(Event.event_type == event_type)
    if resolved_source_ids is not None:
        if not resolved_source_ids:
            return stmt.where(False)
        stmt = stmt.where(Event.source_id.in_(resolved_source_ids))
    if severities:
        stmt = stmt.where(Event.severity.in_(severities))
    if service:
        stmt = stmt.where(Event.service.ilike(f"%{service}%"))
    if host:
        stmt = stmt.where(Event.host.ilike(f"%{host}%"))
    if q:
        stmt = stmt.where(Event.message.ilike(f"%{q}%"))
    return stmt


async def _stream_bootstrap_cursor(
    session: AsyncSession,
    *,
    resolved_source_ids: Optional[list[str]] = None,
    severities: list[str] | None = None,
    service: Optional[str] = None,
    host: Optional[str] = None,
    q: Optional[str] = None,
    event_type: Optional[str] = None,
) -> tuple[datetime, str] | None:
    created_expr = func.coalesce(Event.created_at, Event.timestamp)
    stmt = select(Event)
    stmt = _apply_stream_filters(
        stmt,
        resolved_source_ids=resolved_source_ids,
        severities=severities or [],
        service=service,
        host=host,
        q=q,
        event_type=event_type,
    )
    result = await session.execute(stmt.order_by(created_expr.desc(), Event.id.desc()).limit(1))
    latest = result.scalar_one_or_none()
    if latest is None:
        return None
    created_at = latest.created_at or latest.timestamp
    return _as_utc(created_at), str(latest.id)


def _stream_events_stmt_after(
    cursor: tuple[datetime, str] | None,
    *,
    resolved_source_ids: Optional[list[str]] = None,
    severities: list[str] | None = None,
    service: Optional[str] = None,
    host: Optional[str] = None,
    q: Optional[str] = None,
    event_type: Optional[str] = None,
):
    created_expr = func.coalesce(Event.created_at, Event.timestamp)
    stmt = select(Event)
    stmt = _apply_stream_filters(
        stmt,
        resolved_source_ids=resolved_source_ids,
        severities=severities or [],
        service=service,
        host=host,
        q=q,
        event_type=event_type,
    )
    if cursor is not None:
        after_created_at, after_id = cursor
        stmt = stmt.where(
            or_(
                created_expr > after_created_at,
                and_(created_expr == after_created_at, Event.id > after_id),
            )
        )
    return stmt.order_by(created_expr.asc(), Event.id.asc()).limit(_STREAM_POLL_LIMIT)


@router.get("/stream", summary="Stream events via SSE")
async def stream_events(
    request: Request,
    source_id: Optional[str] = Query(None),
    source_ids: Optional[str] = Query(None),
    source_paths: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    service: Optional[str] = Query(None),
    host: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    event_type: Optional[str] = Query(None),
    poll_interval: int = Query(1, ge=1, le=3600, description="Polling interval in seconds for event batching (default: 1s)"),
):
    """Server-Sent Events stream. Polls the DB for new events after a cursor.

    A fresh DB session is opened and closed on every poll tick so that no
    connection is held open for the full lifetime of the SSE connection.
    """
    factory = get_session_factory()
    severity_values = [value.lower() for value in _parse_csv(severity)]

    async with factory() as setup_session:
        resolved_source_ids = await resolve_source_ids(
            setup_session,
            source_id=source_id,
            source_ids_csv=source_ids,
            source_paths_csv=source_paths,
        )

    async def _generator() -> AsyncGenerator[str, None]:
        last_event_id = request.headers.get("last-event-id") or ""
        cursor = _decode_stream_cursor(last_event_id)

        # Emit an explicit ready event first so clients can mark the stream as
        # connected immediately, even if bootstrap queries are slow.
        yield f"event: ready\ndata: {json.dumps({'type': 'ready'})}\n\n"

        # Bootstrap to "current head" when no reconnect cursor exists,
        # so a fresh client receives only future events.
        async with factory() as session:
            if cursor is None:
                cursor = await _stream_bootstrap_cursor(
                    session,
                    resolved_source_ids=resolved_source_ids,
                    severities=severity_values,
                    service=service,
                    host=host,
                    q=q,
                    event_type=event_type,
                )

        idle_ticks = 0
        recent_emitted_ids: deque[str] = deque()
        recent_emitted_lookup: set[str] = set()
        dedupe_limit = _STREAM_POLL_LIMIT * 8
        if cursor is not None:
            recent_emitted_ids.append(cursor[1])
            recent_emitted_lookup.add(cursor[1])

        while True:
            if await request.is_disconnected():
                break

            async with factory() as session:
                result = await session.execute(
                    _stream_events_stmt_after(
                        cursor,
                        resolved_source_ids=resolved_source_ids,
                        severities=severity_values,
                        service=service,
                        host=host,
                        q=q,
                        event_type=event_type,
                    )
                )
                rows = list(result.scalars().all())

            if not rows:
                idle_ticks += 1
                if idle_ticks >= _STREAM_HEARTBEAT_SECONDS:
                    yield f"event: keepalive\ndata: {json.dumps({'type': 'keepalive'})}\n\n"
                    idle_ticks = 0
                await asyncio.sleep(poll_interval)
                continue

            idle_ticks = 0
            batch = []
            for row in rows:
                if str(row.id) in recent_emitted_lookup:
                    continue
                data = EventResponse.model_validate(row).model_dump(by_alias=False)
                created_at = row.created_at or row.timestamp
                cursor = (_as_utc(created_at), str(row.id))
                encoded_cursor = _encode_stream_cursor(cursor[0], cursor[1])
                batch.append({"id": encoded_cursor, "data": data})
                recent_emitted_ids.append(str(row.id))
                recent_emitted_lookup.add(str(row.id))
                while len(recent_emitted_ids) > dedupe_limit:
                    old_id = recent_emitted_ids.popleft()
                    recent_emitted_lookup.discard(old_id)

            # Send all new events as a batch (array) every poll_interval seconds
            if batch:
                yield f"data: {json.dumps(batch, default=str)}\n\n"

            await asyncio.sleep(poll_interval)

    return StreamingResponse(
        _generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("", response_model=EventListResponse, summary="List events")
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


@router.get("/{event_id}", response_model=EventResponse, summary="Get event")
async def get_event(
    event_id: str,
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(Event).where(Event.id == event_id))
    event = result.scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found.")
    return EventResponse.model_validate(event)
