"""Metrics endpoints – timeseries, top-errors, top-services, error-rate."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from math import floor
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import DBAPIError
from sqlalchemy import and_, case, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.source_filters import resolve_source_ids
from app.config import get_settings
from app.dependencies import get_db
from app.domain.models import Event, EventTimeseriesRollup
from app.schemas.domain import (
    EventVolumeCheckResponse,
    ErrorRateResponse,
    TimeseriesPoint,
    TimeseriesResponse,
    TopErrorItem,
    TopErrorsResponse,
    TopServiceItem,
    TopServicesResponse,
)

router = APIRouter(prefix="/metrics", tags=["Metrics"])

_BUCKET_SECONDS = {
    "1s": 1,
    "5s": 5,
    "15s": 15,
    "30s": 30,
    "1m": 60,
    "5m": 5 * 60,
    "15m": 15 * 60,
    "1h": 60 * 60,
}
# Safety cap for the Python-fallback timeseries path (SQLite / tests).
_TIMESERIES_PYTHON_LIMIT = 200_000
_ROLLUP_BUCKET_SECONDS = 15 * 60
_ROLLUP_MIN_RANGE = timedelta(hours=24)
_ROLLUP_REFRESH_HORIZON = timedelta(hours=6)
_METRICS_QUERY_TIMEOUT_MS = 15_000
_ROLLUP_REFRESH_TIMEOUT_MS = 90_000
_VOLUME_CHECK_TIMEOUT_MS = 25_000
_DATE_BIN_ORIGIN_SQL = text("'1970-01-01 00:00:00+00'::timestamptz")
_ERROR_SEVERITIES = ["error", "critical"]


def _metric_ts_expr(to_dt: datetime):
    """Return timestamp expression for metrics windows.

    We keep source event timestamps as the primary time basis, but guard against
    skewed future timestamps (common with local-time logs parsed as UTC). For
    such rows we fall back to created_at so recent dashboard windows stay useful.
    """
    return case(
        (
            and_(
                Event.created_at.isnot(None),
                Event.timestamp > to_dt,
            ),
            Event.created_at,
        ),
        else_=Event.timestamp,
    )


def _observed_between(from_dt: datetime, to_dt: datetime):
    return _metric_ts_expr(to_dt).between(from_dt, to_dt)


def _default_range() -> tuple[datetime, datetime]:
    """Wide default so 'all time' queries work without explicit from/to."""
    now = datetime.now(timezone.utc)
    return now - timedelta(days=3650), now


def _parse_datetime_param(value: Optional[str]) -> Optional[datetime]:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    if re.search(r"[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)? \d{2}:\d{2}$", normalized):
        normalized = f"{normalized[:-6]}+{normalized[-5:]}"
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _resolve_time_range(from_raw: Optional[str], to_raw: Optional[str]) -> tuple[datetime, datetime]:
    default_from, default_to = _default_range()
    return _parse_datetime_param(from_raw) or default_from, _parse_datetime_param(to_raw) or default_to


def _is_postgres() -> bool:
    return get_settings().database_url.startswith("postgresql")


def _bucket_expr(column, bucket_seconds: int):
    return func.date_bin(
        text(f"'{bucket_seconds} seconds'::interval"),
        column,
        _DATE_BIN_ORIGIN_SQL,
    )


def _floor_bucket(ts: datetime, bucket_seconds: int) -> datetime:
    epoch = floor(ts.timestamp() / bucket_seconds) * bucket_seconds
    return datetime.fromtimestamp(epoch, tz=timezone.utc)


def _ceil_bucket(ts: datetime, bucket_seconds: int) -> datetime:
    floored = _floor_bucket(ts, bucket_seconds)
    if floored == ts:
        return floored
    return floored + timedelta(seconds=bucket_seconds)


def _should_use_rollup(from_dt: datetime, to_dt: datetime, bucket_seconds: int, resolved_source_ids: Optional[list[str]]) -> bool:
    return (
        _is_postgres()
        and resolved_source_ids is not None
        and len(resolved_source_ids) > 0
        and bucket_seconds in {_ROLLUP_BUCKET_SECONDS, 60 * 60}
        and (to_dt - from_dt) >= _ROLLUP_MIN_RANGE
    )


def _raise_if_statement_timeout(exc: DBAPIError) -> None:
    message = str(exc).lower()
    if "statement timeout" in message or "query_canceled" in message or "canceling statement due to statement timeout" in message:
        raise HTTPException(
            status_code=504,
            detail="Metrik-Abfrage hat das Server-Zeitlimit erreicht. Bitte kleineres Zeitfenster oder weniger Quellen waehlen.",
        ) from exc


async def _execute_with_timeout(session: AsyncSession, stmt, *, timeout_ms: int):
    try:
        if _is_postgres():
            await session.execute(text(f"SET LOCAL statement_timeout = {timeout_ms}"))
        return await session.execute(stmt)
    except DBAPIError as exc:
        _raise_if_statement_timeout(exc)
        raise


async def _refresh_rollup_15m(
    session: AsyncSession,
    from_dt: datetime,
    to_dt: datetime,
    resolved_source_ids: list[str],
) -> None:
    aligned_from = _floor_bucket(from_dt, _ROLLUP_BUCKET_SECONDS)
    aligned_to = _ceil_bucket(to_dt, _ROLLUP_BUCKET_SECONDS)
    if aligned_from >= aligned_to:
        return

    observed_ts = _metric_ts_expr(aligned_to)
    bucket_expr = _bucket_expr(observed_ts, _ROLLUP_BUCKET_SECONDS).label("bucket_start")
    aggregate_stmt = (
        select(
            Event.source_id.label("source_id"),
            bucket_expr,
            func.count().label("total_count"),
            func.count(Event.id).filter(Event.severity.in_(_ERROR_SEVERITIES)).label("error_count"),
            func.now().label("updated_at"),
        )
        .where(
            observed_ts >= aligned_from,
            observed_ts < aligned_to,
            Event.source_id.in_(resolved_source_ids),
        )
        .group_by(Event.source_id, text("bucket_start"))
    )

    insert_stmt = pg_insert(EventTimeseriesRollup).from_select(
        ["source_id", "bucket_start", "total_count", "error_count", "updated_at"],
        aggregate_stmt,
    )
    upsert_stmt = insert_stmt.on_conflict_do_update(
        index_elements=["source_id", "bucket_start"],
        set_={
            "total_count": insert_stmt.excluded.total_count,
            "error_count": insert_stmt.excluded.error_count,
            "updated_at": func.now(),
        },
    )
    await _execute_with_timeout(session, upsert_stmt, timeout_ms=_ROLLUP_REFRESH_TIMEOUT_MS)


async def _query_raw_timeseries_slice(
    session: AsyncSession,
    from_dt: datetime,
    to_dt: datetime,
    bucket_seconds: int,
    resolved_source_ids: list[str],
) -> dict[datetime, int]:
    if from_dt >= to_dt:
        return {}
    observed_ts = _metric_ts_expr(to_dt)
    bucket_expr = _bucket_expr(observed_ts, bucket_seconds).label("bucket")
    stmt = (
        select(bucket_expr, func.count().label("count"))
        .where(
            observed_ts >= from_dt,
            observed_ts < to_dt,
            Event.source_id.in_(resolved_source_ids),
        )
        .group_by(text("bucket"))
        .order_by(text("bucket"))
    )
    result = await _execute_with_timeout(session, stmt, timeout_ms=_METRICS_QUERY_TIMEOUT_MS)
    return {
        row._mapping["bucket"]: int(row._mapping["count"] or 0)
        for row in result
    }


async def _query_rollup_timeseries(
    session: AsyncSession,
    from_dt: datetime,
    to_dt: datetime,
    bucket_seconds: int,
    resolved_source_ids: list[str],
) -> list[TimeseriesPoint]:
    refresh_from = max(from_dt, to_dt - _ROLLUP_REFRESH_HORIZON)
    if refresh_from < to_dt:
        await _refresh_rollup_15m(session, refresh_from, to_dt, resolved_source_ids)

    merged: dict[datetime, int] = {}
    inner_from = _ceil_bucket(from_dt, _ROLLUP_BUCKET_SECONDS)
    inner_to = _floor_bucket(to_dt, _ROLLUP_BUCKET_SECONDS)

    head = await _query_raw_timeseries_slice(session, from_dt, min(to_dt, inner_from), bucket_seconds, resolved_source_ids)
    for bucket_ts, count in head.items():
        merged[bucket_ts] = merged.get(bucket_ts, 0) + count

    if inner_from < inner_to:
        rollup_bucket_expr = _bucket_expr(EventTimeseriesRollup.bucket_start, bucket_seconds).label("bucket")
        rollup_stmt = (
            select(rollup_bucket_expr, func.sum(EventTimeseriesRollup.total_count).label("count"))
            .where(
                EventTimeseriesRollup.bucket_start >= inner_from,
                EventTimeseriesRollup.bucket_start < inner_to,
                EventTimeseriesRollup.source_id.in_(resolved_source_ids),
            )
            .group_by(text("bucket"))
            .order_by(text("bucket"))
        )
        rollup_result = await _execute_with_timeout(session, rollup_stmt, timeout_ms=_METRICS_QUERY_TIMEOUT_MS)
        for row in rollup_result:
            bucket_ts = row._mapping["bucket"]
            merged[bucket_ts] = merged.get(bucket_ts, 0) + int(row._mapping["count"] or 0)

    tail = await _query_raw_timeseries_slice(session, max(from_dt, inner_to), to_dt, bucket_seconds, resolved_source_ids)
    for bucket_ts, count in tail.items():
        merged[bucket_ts] = merged.get(bucket_ts, 0) + count

    return [TimeseriesPoint(ts=ts, count=count) for ts, count in sorted(merged.items())]


async def _query_raw_stats_slice(
    session: AsyncSession,
    from_dt: datetime,
    to_dt: datetime,
    resolved_source_ids: list[str],
) -> tuple[int, int]:
    if from_dt >= to_dt:
        return 0, 0
    observed_ts = _metric_ts_expr(to_dt)
    stmt = (
        select(
            func.count().label("total"),
            func.count(Event.id).filter(Event.severity.in_(_ERROR_SEVERITIES)).label("errors"),
        )
        .where(
            observed_ts >= from_dt,
            observed_ts < to_dt,
            Event.source_id.in_(resolved_source_ids),
        )
    )
    result = await _execute_with_timeout(session, stmt, timeout_ms=_METRICS_QUERY_TIMEOUT_MS)
    row = result.one()
    return int(row.total or 0), int(row.errors or 0)


async def _query_rollup_error_rate_stats(
    session: AsyncSession,
    from_dt: datetime,
    to_dt: datetime,
    resolved_source_ids: list[str],
) -> tuple[int, int]:
    refresh_from = max(from_dt, to_dt - _ROLLUP_REFRESH_HORIZON)
    if refresh_from < to_dt:
        await _refresh_rollup_15m(session, refresh_from, to_dt, resolved_source_ids)

    total_events = 0
    error_events = 0

    inner_from = _ceil_bucket(from_dt, _ROLLUP_BUCKET_SECONDS)
    inner_to = _floor_bucket(to_dt, _ROLLUP_BUCKET_SECONDS)

    head_total, head_errors = await _query_raw_stats_slice(session, from_dt, min(to_dt, inner_from), resolved_source_ids)
    total_events += head_total
    error_events += head_errors

    if inner_from < inner_to:
        rollup_stmt = (
            select(
                func.coalesce(func.sum(EventTimeseriesRollup.total_count), 0).label("total"),
                func.coalesce(func.sum(EventTimeseriesRollup.error_count), 0).label("errors"),
            )
            .where(
                EventTimeseriesRollup.bucket_start >= inner_from,
                EventTimeseriesRollup.bucket_start < inner_to,
                EventTimeseriesRollup.source_id.in_(resolved_source_ids),
            )
        )
        rollup_result = await _execute_with_timeout(session, rollup_stmt, timeout_ms=_METRICS_QUERY_TIMEOUT_MS)
        row = rollup_result.one()
        total_events += int(row.total or 0)
        error_events += int(row.errors or 0)

    tail_total, tail_errors = await _query_raw_stats_slice(session, max(from_dt, inner_to), to_dt, resolved_source_ids)
    total_events += tail_total
    error_events += tail_errors

    return total_events, error_events


async def _query_rollup_volume_check(
    session: AsyncSession,
    from_dt: datetime,
    to_dt: datetime,
    resolved_source_ids: list[str],
    threshold: int,
) -> tuple[int, bool]:
    refresh_from = max(from_dt, to_dt - _ROLLUP_REFRESH_HORIZON)
    if refresh_from < to_dt:
        await _refresh_rollup_15m(session, refresh_from, to_dt, resolved_source_ids)

    total_events = 0
    inner_from = _ceil_bucket(from_dt, _ROLLUP_BUCKET_SECONDS)
    inner_to = _floor_bucket(to_dt, _ROLLUP_BUCKET_SECONDS)

    head_total, _ = await _query_raw_stats_slice(session, from_dt, min(to_dt, inner_from), resolved_source_ids)
    total_events += head_total
    if total_events > threshold:
        return threshold + 1, True

    if inner_from < inner_to:
        rollup_stmt = (
            select(func.coalesce(func.sum(EventTimeseriesRollup.total_count), 0).label("total"))
            .where(
                EventTimeseriesRollup.bucket_start >= inner_from,
                EventTimeseriesRollup.bucket_start < inner_to,
                EventTimeseriesRollup.source_id.in_(resolved_source_ids),
            )
        )
        rollup_result = await _execute_with_timeout(session, rollup_stmt, timeout_ms=_METRICS_QUERY_TIMEOUT_MS)
        row = rollup_result.one()
        total_events += int(row.total or 0)
        if total_events > threshold:
            return threshold + 1, True

    tail_total, _ = await _query_raw_stats_slice(session, max(from_dt, inner_to), to_dt, resolved_source_ids)
    total_events += tail_total
    requires_confirmation = total_events > threshold
    return (threshold + 1 if requires_confirmation else total_events), requires_confirmation


@router.get("/timeseries", response_model=TimeseriesResponse)
async def timeseries(
    session: AsyncSession = Depends(get_db),
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    bucket: str = Query("15s", pattern="^(1s|5s|15s|30s|1m|5m|15m|1h)$"),
    source_ids: Optional[str] = Query(None),
    source_paths: Optional[str] = Query(None),
):
    from_dt, to_dt = _resolve_time_range(from_, to)
    resolved_source_ids = await resolve_source_ids(session, source_ids_csv=source_ids, source_paths_csv=source_paths)
    if resolved_source_ids == []:
        return TimeseriesResponse(points=[])

    bucket_seconds = _BUCKET_SECONDS.get(bucket, 15)
    is_postgres = _is_postgres()

    if _should_use_rollup(from_dt, to_dt, bucket_seconds, resolved_source_ids):
        points = await _query_rollup_timeseries(session, from_dt, to_dt, bucket_seconds, resolved_source_ids or [])
        return TimeseriesResponse(points=points)

    if is_postgres:
        # Push bucketing entirely into PostgreSQL — returns one row per bucket,
        # not one row per event. Scales to millions of events with no extra memory.
        observed_ts = _metric_ts_expr(to_dt)
        bucket_expr = _bucket_expr(observed_ts, bucket_seconds).label("bucket")
        stmt = (
            select(bucket_expr, func.count().label("count"))
            .where(_observed_between(from_dt, to_dt))
            .group_by(text("bucket"))
            .order_by(text("bucket"))
        )
        if resolved_source_ids is not None:
            stmt = stmt.where(Event.source_id.in_(resolved_source_ids))
        result = await _execute_with_timeout(session, stmt, timeout_ms=_METRICS_QUERY_TIMEOUT_MS)
        points = [TimeseriesPoint(ts=row.bucket, count=int(row.count) if isinstance(row.count, (int, float)) else 0) for row in result]
        return TimeseriesResponse(points=points)

    # SQLite fallback (used in tests): fetch timestamps with a safety LIMIT
    # and bucket in Python.
    stmt = (
        select(_metric_ts_expr(to_dt).label("observed_ts"))
        .where(_observed_between(from_dt, to_dt))
        .order_by(text("observed_ts"))
        .limit(_TIMESERIES_PYTHON_LIMIT)
    )
    if resolved_source_ids is not None:
        stmt = stmt.where(Event.source_id.in_(resolved_source_ids))

    result = await _execute_with_timeout(session, stmt, timeout_ms=_METRICS_QUERY_TIMEOUT_MS)
    timestamps = [row[0] for row in result.all()]

    merged: dict[datetime, int] = {}
    for ts in timestamps:
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        rounded_epoch = floor(ts.timestamp() / bucket_seconds) * bucket_seconds
        bucket_ts = datetime.fromtimestamp(rounded_epoch, tz=timezone.utc)
        merged[bucket_ts] = merged.get(bucket_ts, 0) + 1

    points = [TimeseriesPoint(ts=ts, count=cnt) for ts, cnt in sorted(merged.items())]
    return TimeseriesResponse(points=points)


@router.get("/top-errors", response_model=TopErrorsResponse)
async def top_errors(
    session: AsyncSession = Depends(get_db),
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    source_ids: Optional[str] = Query(None),
    source_paths: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
):
    from_dt, to_dt = _resolve_time_range(from_, to)
    resolved_source_ids = await resolve_source_ids(session, source_ids_csv=source_ids, source_paths_csv=source_paths)
    if resolved_source_ids == []:
        return TopErrorsResponse(items=[])

    severity_levels = ["error", "critical"]
    if severity:
        severity_levels = [s.strip().lower() for s in severity.split(",") if s.strip()]
        if not severity_levels:
            severity_levels = ["error", "critical"]

    stmt = (
        select(
            Event.message,
            func.count().label("count"),
            func.max(_metric_ts_expr(to_dt)).label("latest")
        )
        .where(
            _observed_between(from_dt, to_dt),
            Event.severity.in_(severity_levels),
        )
        .group_by(Event.message)
        .order_by(text("latest DESC"))
        .limit(20)
    )
    if resolved_source_ids is not None:
        stmt = stmt.where(Event.source_id.in_(resolved_source_ids))

    result = await _execute_with_timeout(session, stmt, timeout_ms=_METRICS_QUERY_TIMEOUT_MS)
    items = [TopErrorItem(key=row.message, count=int(row.count) if isinstance(row.count, (int, float)) else 0, latest=row.latest) for row in result]
    return TopErrorsResponse(items=items)


@router.get("/top-services", response_model=TopServicesResponse)
async def top_services(
    session: AsyncSession = Depends(get_db),
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    source_ids: Optional[str] = Query(None),
    source_paths: Optional[str] = Query(None),
):
    from_dt, to_dt = _resolve_time_range(from_, to)
    resolved_source_ids = await resolve_source_ids(session, source_ids_csv=source_ids, source_paths_csv=source_paths)
    if resolved_source_ids == []:
        return TopServicesResponse(items=[])

    stmt = (
        select(Event.service, func.count().label("count"))
        .where(
            _observed_between(from_dt, to_dt),
            Event.service.isnot(None),
        )
        .group_by(Event.service)
        .order_by(text("count DESC"))
        .limit(20)
    )
    if resolved_source_ids is not None:
        stmt = stmt.where(Event.source_id.in_(resolved_source_ids))

    result = await _execute_with_timeout(session, stmt, timeout_ms=_METRICS_QUERY_TIMEOUT_MS)
    items = [TopServiceItem(service=row.service, count=int(row.count) if isinstance(row.count, (int, float)) else 0) for row in result]
    return TopServicesResponse(items=items)


@router.get("/error-rate", response_model=ErrorRateResponse)
async def error_rate(
    session: AsyncSession = Depends(get_db),
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    source_ids: Optional[str] = Query(None),
    source_paths: Optional[str] = Query(None),
):
    from_dt, to_dt = _resolve_time_range(from_, to)
    resolved_source_ids = await resolve_source_ids(session, source_ids_csv=source_ids, source_paths_csv=source_paths)
    if resolved_source_ids == []:
        return ErrorRateResponse(total_events=0, error_events=0, error_rate=0.0)

    if _should_use_rollup(from_dt, to_dt, _ROLLUP_BUCKET_SECONDS, resolved_source_ids):
        total, errors = await _query_rollup_error_rate_stats(session, from_dt, to_dt, resolved_source_ids or [])
        rate = round(errors / total, 4) if total > 0 else 0.0
        return ErrorRateResponse(total_events=total, error_events=errors, error_rate=rate)

    stats_stmt = select(
        func.count().label("total"),
        func.count(Event.id).filter(Event.severity.in_(_ERROR_SEVERITIES)).label("errors"),
    ).where(_observed_between(from_dt, to_dt))
    if resolved_source_ids is not None:
        stats_stmt = stats_stmt.where(Event.source_id.in_(resolved_source_ids))

    stats_result = await _execute_with_timeout(session, stats_stmt, timeout_ms=_METRICS_QUERY_TIMEOUT_MS)
    stats_row = stats_result.one()
    total = int(stats_row.total or 0)
    errors = int(stats_row.errors or 0)

    rate = round(errors / total, 4) if total > 0 else 0.0
    return ErrorRateResponse(total_events=total, error_events=errors, error_rate=rate)


@router.get("/volume-check", response_model=EventVolumeCheckResponse)
async def volume_check(
    session: AsyncSession = Depends(get_db),
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    source_ids: Optional[str] = Query(None),
    source_paths: Optional[str] = Query(None),
    threshold: int = Query(5_000_000, ge=1, le=50_000_000),
):
    """Check whether a query window exceeds a safety threshold.

    The count is capped at threshold + 1 so this endpoint can quickly answer
    whether confirmation is required without scanning all matching rows.
    """
    from_dt, to_dt = _resolve_time_range(from_, to)
    resolved_source_ids = await resolve_source_ids(session, source_ids_csv=source_ids, source_paths_csv=source_paths)
    if resolved_source_ids == []:
        return EventVolumeCheckResponse(
            threshold=threshold,
            checked_events=0,
            requires_confirmation=False,
            capped=False,
        )

    if _should_use_rollup(from_dt, to_dt, _ROLLUP_BUCKET_SECONDS, resolved_source_ids):
        checked_events, requires_confirmation = await _query_rollup_volume_check(
            session,
            from_dt,
            to_dt,
            resolved_source_ids or [],
            threshold,
        )
        return EventVolumeCheckResponse(
            threshold=threshold,
            checked_events=checked_events,
            requires_confirmation=requires_confirmation,
            capped=requires_confirmation,
        )

    capped_limit = threshold + 1
    limited_stmt = select(Event.id).where(_observed_between(from_dt, to_dt)).limit(capped_limit)
    if resolved_source_ids is not None:
        limited_stmt = limited_stmt.where(Event.source_id.in_(resolved_source_ids))

    limited_subquery = limited_stmt.subquery()
    count_result = await _execute_with_timeout(
        session,
        select(func.count()).select_from(limited_subquery),
        timeout_ms=_VOLUME_CHECK_TIMEOUT_MS,
    )
    checked_events = int(count_result.scalar_one() or 0)
    requires_confirmation = checked_events > threshold

    return EventVolumeCheckResponse(
        threshold=threshold,
        checked_events=checked_events,
        requires_confirmation=requires_confirmation,
        capped=requires_confirmation,
    )
