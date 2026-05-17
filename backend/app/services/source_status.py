from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.models import Event, SourceIngestionStatus

_PARSE_ERROR_WINDOW = timedelta(hours=1)


async def refresh_source_status(
    session: AsyncSession,
    source_id: str,
    *,
    touched_at: datetime | None = None,
) -> None:
    now = touched_at or datetime.now(timezone.utc)
    one_minute_ago = now - timedelta(minutes=1)
    one_hour_ago = now - _PARSE_ERROR_WINDOW

    last_event_timestamp_result = await session.execute(
        select(Event.timestamp)
        .where(Event.source_id == source_id)
        .order_by(Event.timestamp.desc())
        .limit(1)
    )
    last_event_timestamp = last_event_timestamp_result.scalar_one_or_none()

    last_event_created_result = await session.execute(
        select(Event.created_at)
        .where(Event.source_id == source_id)
        .order_by(Event.created_at.desc())
        .limit(1)
    )
    last_event_created_at = last_event_created_result.scalar_one_or_none()

    events_per_min_result = await session.execute(
        select(func.count(Event.id)).where(
            Event.source_id == source_id,
            Event.created_at >= one_minute_ago,
        )
    )
    events_per_min = int(events_per_min_result.scalar_one() or 0)

    parse_error_count_result = await session.execute(
        select(func.count(Event.id)).where(
            Event.source_id == source_id,
            Event.created_at >= one_hour_ago,
            Event.fields_json.contains({"ingest_parse_error": True}),
        )
    )
    parse_error_count = int(parse_error_count_result.scalar_one() or 0)

    upsert_stmt = pg_insert(SourceIngestionStatus).values(
        source_id=source_id,
        last_ingested_at=now,
        last_event_timestamp=last_event_timestamp,
        last_event_created_at=last_event_created_at,
        last_seen_at=last_event_created_at,
        events_per_min=events_per_min,
        parse_error_count=parse_error_count,
        updated_at=now,
    )
    upsert_stmt = upsert_stmt.on_conflict_do_update(
        index_elements=[SourceIngestionStatus.source_id],
        set_={
            "last_ingested_at": now,
            "last_event_timestamp": last_event_timestamp,
            "last_event_created_at": last_event_created_at,
            "last_seen_at": last_event_created_at,
            "events_per_min": events_per_min,
            "parse_error_count": parse_error_count,
            "updated_at": now,
        },
    )
    await session.execute(upsert_stmt)
