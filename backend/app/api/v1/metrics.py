"""Metrics endpoints – timeseries, top-errors, top-services, error-rate."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.source_filters import resolve_source_ids
from app.dependencies import get_db
from app.domain.models import Event
from app.schemas.domain import (
    ErrorRateResponse,
    TimeseriesPoint,
    TimeseriesResponse,
    TopErrorItem,
    TopErrorsResponse,
    TopServiceItem,
    TopServicesResponse,
)

router = APIRouter(prefix="/metrics", tags=["Metrics"])

_BUCKET_INTERVALS = {
    "1m": "1 minute",
    "5m": "5 minutes",
    "15m": "15 minutes",
    "1h": "1 hour",
}


def _default_range() -> tuple[datetime, datetime]:
    """Wide default so 'all time' queries work without explicit from/to."""
    now = datetime.now(timezone.utc)
    return now - timedelta(days=3650), now


@router.get("/timeseries", response_model=TimeseriesResponse)
async def timeseries(
    session: AsyncSession = Depends(get_db),
    from_: Optional[datetime] = Query(None, alias="from"),
    to: Optional[datetime] = Query(None),
    bucket: str = Query("5m", pattern="^(1m|5m|15m|1h)$"),
    source_ids: Optional[str] = Query(None),
    source_paths: Optional[str] = Query(None),
):
    from_dt, to_dt = from_ or _default_range()[0], to or _default_range()[1]
    resolved_source_ids = await resolve_source_ids(session, source_ids_csv=source_ids, source_paths_csv=source_paths)
    if resolved_source_ids == []:
        return TimeseriesResponse(points=[])

    # Fetch raw timestamps — bucket in Python for DB portability (SQLite + PostgreSQL).
    stmt = (
        select(Event.timestamp)
        .where(Event.timestamp >= from_dt, Event.timestamp <= to_dt)
        .order_by(Event.timestamp)
    )
    if resolved_source_ids is not None:
        stmt = stmt.where(Event.source_id.in_(resolved_source_ids))

    result = await session.execute(stmt)
    timestamps = [row[0] for row in result.all()]

    bucket_minutes = {"1m": 1, "5m": 5, "15m": 15, "1h": 60}.get(bucket, 5)
    merged: dict[datetime, int] = {}
    for ts in timestamps:
        # Ensure timezone-aware for consistent bucketing
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        minutes = (ts.minute // bucket_minutes) * bucket_minutes
        bucket_ts = ts.replace(minute=minutes, second=0, microsecond=0)
        merged[bucket_ts] = merged.get(bucket_ts, 0) + 1

    points = [TimeseriesPoint(ts=ts, count=cnt) for ts, cnt in sorted(merged.items())]
    return TimeseriesResponse(points=points)


@router.get("/top-errors", response_model=TopErrorsResponse)
async def top_errors(
    session: AsyncSession = Depends(get_db),
    from_: Optional[datetime] = Query(None, alias="from"),
    to: Optional[datetime] = Query(None),
    source_ids: Optional[str] = Query(None),
    source_paths: Optional[str] = Query(None),
):
    from_dt, to_dt = from_ or _default_range()[0], to or _default_range()[1]
    resolved_source_ids = await resolve_source_ids(session, source_ids_csv=source_ids, source_paths_csv=source_paths)
    if resolved_source_ids == []:
        return TopErrorsResponse(items=[])

    stmt = (
        select(Event.message, func.count().label("count"))
        .where(
            Event.timestamp >= from_dt,
            Event.timestamp <= to_dt,
            Event.severity.in_(["error", "critical"]),
        )
        .group_by(Event.message)
        .order_by(text("count DESC"))
        .limit(20)
    )
    if resolved_source_ids is not None:
        stmt = stmt.where(Event.source_id.in_(resolved_source_ids))

    result = await session.execute(stmt)
    items = [TopErrorItem(key=row.message, count=row.count) for row in result]
    return TopErrorsResponse(items=items)


@router.get("/top-services", response_model=TopServicesResponse)
async def top_services(
    session: AsyncSession = Depends(get_db),
    from_: Optional[datetime] = Query(None, alias="from"),
    to: Optional[datetime] = Query(None),
    source_ids: Optional[str] = Query(None),
    source_paths: Optional[str] = Query(None),
):
    from_dt, to_dt = from_ or _default_range()[0], to or _default_range()[1]
    resolved_source_ids = await resolve_source_ids(session, source_ids_csv=source_ids, source_paths_csv=source_paths)
    if resolved_source_ids == []:
        return TopServicesResponse(items=[])

    stmt = (
        select(Event.service, func.count().label("count"))
        .where(
            Event.timestamp >= from_dt,
            Event.timestamp <= to_dt,
            Event.service.isnot(None),
        )
        .group_by(Event.service)
        .order_by(text("count DESC"))
        .limit(20)
    )
    if resolved_source_ids is not None:
        stmt = stmt.where(Event.source_id.in_(resolved_source_ids))

    result = await session.execute(stmt)
    items = [TopServiceItem(service=row.service, count=row.count) for row in result]
    return TopServicesResponse(items=items)


@router.get("/error-rate", response_model=ErrorRateResponse)
async def error_rate(
    session: AsyncSession = Depends(get_db),
    from_: Optional[datetime] = Query(None, alias="from"),
    to: Optional[datetime] = Query(None),
    source_ids: Optional[str] = Query(None),
    source_paths: Optional[str] = Query(None),
):
    from_dt, to_dt = from_ or _default_range()[0], to or _default_range()[1]
    resolved_source_ids = await resolve_source_ids(session, source_ids_csv=source_ids, source_paths_csv=source_paths)
    if resolved_source_ids == []:
        return ErrorRateResponse(total_events=0, error_events=0, error_rate=0.0)

    total_stmt = select(func.count()).where(Event.timestamp >= from_dt, Event.timestamp <= to_dt)
    if resolved_source_ids is not None:
        total_stmt = total_stmt.where(Event.source_id.in_(resolved_source_ids))

    total_result = await session.execute(total_stmt)
    total = total_result.scalar_one() or 0

    error_stmt = select(func.count()).where(
        Event.timestamp >= from_dt,
        Event.timestamp <= to_dt,
        Event.severity.in_(["error", "critical"]),
    )
    if resolved_source_ids is not None:
        error_stmt = error_stmt.where(Event.source_id.in_(resolved_source_ids))

    error_result = await session.execute(error_stmt)
    errors = error_result.scalar_one() or 0

    rate = round(errors / total, 4) if total > 0 else 0.0
    return ErrorRateResponse(total_events=total, error_events=errors, error_rate=rate)
