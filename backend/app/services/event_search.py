"""Event search provider routing (PostgreSQL and optional Elasticsearch)."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.domain.models import Event
from app.schemas.event import EventResponse
from app.services.elastic_client import ElasticClient


@dataclass(slots=True)
class EventSearchQuery:
    from_ts: datetime | None
    to_ts: datetime | None
    resolved_source_ids: list[str] | None
    severity: str | None
    service: str | None
    host: str | None
    q: str | None
    limit: int
    cursor: str | None
    use_created_at_window_only: bool = False


@dataclass(slots=True)
class EventSearchResult:
    items: list[EventResponse]
    next_cursor: str | None
    provider_used: str


def _severity_values(severity: str | None) -> list[str]:
    if not severity:
        return []
    return [value.strip().lower() for value in severity.split(",") if value.strip()]


def _parse_cursor(cursor: str | None) -> datetime | None:
    if not cursor:
        return None
    try:
        return datetime.fromisoformat(cursor)
    except ValueError:
        return None


async def search_events_postgres(session: AsyncSession, query: EventSearchQuery) -> EventSearchResult:
    # Sort primarily by ingestion time, then by event timestamp so events from
    # the same ingest batch still appear newest-first in the UI.
    stmt = (
        select(Event)
        .order_by(Event.created_at.desc(), Event.timestamp.desc(), Event.id.desc())
        .limit(query.limit + 1)
    )

    if query.use_created_at_window_only:
        if query.from_ts and query.to_ts:
            stmt = stmt.where(Event.created_at.between(query.from_ts, query.to_ts))
        elif query.from_ts:
            stmt = stmt.where(Event.created_at >= query.from_ts)
        elif query.to_ts:
            stmt = stmt.where(Event.created_at <= query.to_ts)
    else:
        if query.from_ts and query.to_ts:
            stmt = stmt.where(
                or_(
                    Event.timestamp.between(query.from_ts, query.to_ts),
                    Event.created_at.between(query.from_ts, query.to_ts),
                )
            )
        elif query.from_ts:
            stmt = stmt.where(or_(Event.timestamp >= query.from_ts, Event.created_at >= query.from_ts))
        elif query.to_ts:
            stmt = stmt.where(or_(Event.timestamp <= query.to_ts, Event.created_at <= query.to_ts))
    if query.resolved_source_ids is not None:
        stmt = stmt.where(Event.source_id.in_(query.resolved_source_ids))

    severity_values = _severity_values(query.severity)
    if severity_values:
        stmt = stmt.where(Event.severity.in_(severity_values))

    if query.service:
        stmt = stmt.where(Event.service.ilike(f"%{query.service}%"))
    if query.host:
        stmt = stmt.where(Event.host.ilike(f"%{query.host}%"))
    if query.q:
        stmt = stmt.where(Event.message.ilike(f"%{query.q}%"))

    cursor_ts = _parse_cursor(query.cursor)
    if cursor_ts:
        stmt = stmt.where(Event.created_at < cursor_ts)

    result = await session.execute(stmt)
    rows = list(result.scalars().all())

    next_cursor: str | None = None
    if len(rows) > query.limit:
        rows = rows[:query.limit]
        next_cursor = rows[-1].created_at.isoformat()

    return EventSearchResult(
        items=[EventResponse.model_validate(row) for row in rows],
        next_cursor=next_cursor,
        provider_used="postgres",
    )


async def search_events_elastic(
    session: AsyncSession,
    query: EventSearchQuery,
    *,
    elastic_is_available: bool,
) -> EventSearchResult:
    settings = get_settings()
    if not settings.elastic_enabled:
        raise RuntimeError("elastic_disabled")
    if not elastic_is_available:
        raise RuntimeError("elastic_unavailable")

    cursor_ts = _parse_cursor(query.cursor)
    rows, next_cursor = await ElasticClient.from_settings(settings).search_events(
        index_pattern=settings.elastic_index_pattern,
        from_ts=query.from_ts,
        to_ts=query.to_ts,
        source_ids=query.resolved_source_ids,
        severity_values=_severity_values(query.severity),
        service=query.service,
        host=query.host,
        q=query.q,
        limit=query.limit,
        cursor=cursor_ts,
    )

    items: list[EventResponse] = []
    for row in rows:
        item_payload = {
            "id": row.get("event_id"),
            "source_id": row.get("source_id"),
            "timestamp": row.get("timestamp"),
            "severity": row.get("severity") or "info",
            "service": row.get("service"),
            "host": row.get("host"),
            "environment": row.get("environment"),
            "event_type": row.get("event_type"),
            "message": row.get("message") or "",
            "fields_json": row.get("fields_json") or {},
            "fingerprint": row.get("fingerprint"),
            "created_at": row.get("created_at") or row.get("timestamp"),
        }
        items.append(EventResponse.model_validate(item_payload))

    return EventSearchResult(items=items, next_cursor=next_cursor, provider_used="elastic")
