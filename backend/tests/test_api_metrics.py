"""Tests for metrics API endpoints (Point 3: Dashboard echte Daten).

These tests verify that the metrics endpoints return real data from the DB,
and that the default behaviour (no source filter) returns aggregated totals.

The timeseries endpoint uses date_trunc (PostgreSQL). For SQLite we need
a fallback; the implementation must handle both gracefully.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1 import metrics as metrics_api
from app.domain.models import Event, EventTimeseriesRollup, Source


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_source(session: AsyncSession, *, name: str = "test-src") -> Source:
    s = Source(
        name=name,
        type="file",
        enabled=True,
        config_json={"path": f"/var/log/{name}.log"},
    )
    session.add(s)
    return s


def _make_event(
    session: AsyncSession,
    source: Source,
    *,
    severity: str = "info",
    message: str = "test message",
    service: str | None = "svc",
    event_type: str = "log",
    fields: dict | None = None,
    ts: datetime | None = None,
    created_at: datetime | None = None,
) -> Event:
    e = Event(
        source_id=source.id,
        timestamp=ts or datetime.now(timezone.utc),
        created_at=created_at,
        severity=severity,
        message=message,
        service=service,
        host="host1",
        environment="test",
        event_type=event_type,
        fields_json=fields or {},
        fingerprint="fp-" + message[:8].replace(" ", "-"),
    )
    session.add(e)
    return e


# ---------------------------------------------------------------------------
# /metrics/timeseries
# ---------------------------------------------------------------------------

class TestTimeseries:
    async def test_returns_200_with_no_events(self, client, db_session):
        resp = await client.get("/api/v1/metrics/timeseries")
        assert resp.status_code == 200
        data = resp.json()
        assert "points" in data
        assert isinstance(data["points"], list)

    async def test_returns_points_for_ingested_events(self, client, db_session):
        src = _make_source(db_session, name="metrics-src")
        db_session.add(src)
        await db_session.flush()
        _make_event(db_session, src, message="hello1")
        _make_event(db_session, src, message="hello2")
        await db_session.commit()

        resp = await client.get("/api/v1/metrics/timeseries")
        assert resp.status_code == 200
        data = resp.json()
        assert sum(p["count"] for p in data["points"]) >= 2

    async def test_source_filter_by_id_limits_results(self, client, db_session):
        src_a = _make_source(db_session, name="src-a")
        src_b = _make_source(db_session, name="src-b")
        db_session.add_all([src_a, src_b])
        await db_session.flush()
        _make_event(db_session, src_a, message="from-a")
        _make_event(db_session, src_b, message="from-b")
        await db_session.commit()

        resp = await client.get(f"/api/v1/metrics/timeseries?source_ids={src_a.id}")
        assert resp.status_code == 200
        total = sum(p["count"] for p in resp.json()["points"])
        assert total == 1

    async def test_recent_window_uses_ingest_time_for_fresh_historical_events(self, client, db_session):
        src = _make_source(db_session, name="recent-ingest-src")
        db_session.add(src)
        await db_session.flush()
        now = datetime.now(timezone.utc)
        _make_event(
            db_session,
            src,
            message="historical-log-fresh-ingest",
            ts=now - timedelta(hours=12),
            created_at=now,
        )
        await db_session.commit()

        from_ts = (now - timedelta(minutes=1)).isoformat()
        to_ts = (now + timedelta(seconds=1)).isoformat()
        resp = await client.get(f"/api/v1/metrics/timeseries?from={from_ts}&to={to_ts}&bucket=1m")
        assert resp.status_code == 200
        assert sum(point["count"] for point in resp.json()["points"]) == 1

    async def test_accepts_one_second_bucket(self, client, db_session):
        src = _make_source(db_session, name="one-second-bucket-src")
        db_session.add(src)
        await db_session.flush()
        now = datetime.now(timezone.utc)
        _make_event(db_session, src, message="bucket-1s", ts=now, created_at=now)
        await db_session.commit()

        from_ts = (now - timedelta(seconds=5)).isoformat()
        to_ts = (now + timedelta(seconds=1)).isoformat()
        resp = await client.get(f"/api/v1/metrics/timeseries?from={from_ts}&to={to_ts}&bucket=1s")
        assert resp.status_code == 200
        assert sum(point["count"] for point in resp.json()["points"]) == 1

    async def test_recent_window_falls_back_for_future_skewed_timestamp(self, client, db_session):
        src = _make_source(db_session, name="timeseries-future-skew-src")
        db_session.add(src)
        await db_session.flush()
        now = datetime.now(timezone.utc)
        _make_event(
            db_session,
            src,
            message="future skewed timeseries event",
            ts=now + timedelta(hours=2),
            created_at=now,
        )
        await db_session.commit()

        from_ts = (now - timedelta(minutes=1)).isoformat()
        to_ts = (now + timedelta(seconds=1)).isoformat()
        resp = await client.get(f"/api/v1/metrics/timeseries?from={from_ts}&to={to_ts}&bucket=1m")
        assert resp.status_code == 200
        assert sum(point["count"] for point in resp.json()["points"]) == 1


# ---------------------------------------------------------------------------
# /metrics/top-errors
# ---------------------------------------------------------------------------

class TestTopErrors:
    async def test_returns_200_with_no_events(self, client, db_session):
        resp = await client.get("/api/v1/metrics/top-errors")
        assert resp.status_code == 200
        assert resp.json()["items"] == []

    async def test_counts_error_and_critical_events(self, client, db_session):
        src = _make_source(db_session, name="top-err-src")
        db_session.add(src)
        await db_session.flush()
        _make_event(db_session, src, severity="error", message="connection refused")
        _make_event(db_session, src, severity="error", message="connection refused")
        _make_event(db_session, src, severity="critical", message="out of memory")
        _make_event(db_session, src, severity="info", message="all good")
        await db_session.commit()

        resp = await client.get("/api/v1/metrics/top-errors")
        assert resp.status_code == 200
        items = resp.json()["items"]
        assert len(items) >= 2
        top = max(items, key=lambda x: x["count"])
        assert top["count"] == 2

    async def test_info_events_not_in_top_errors(self, client, db_session):
        src = _make_source(db_session, name="info-only-src")
        db_session.add(src)
        await db_session.flush()
        _make_event(db_session, src, severity="info", message="startup")
        await db_session.commit()

        resp = await client.get("/api/v1/metrics/top-errors")
        assert resp.json()["items"] == []

    async def test_top_errors_recent_window_uses_ingest_time_for_fresh_historical_events(self, client, db_session):
        src = _make_source(db_session, name="top-errors-recent-src")
        db_session.add(src)
        await db_session.flush()
        now = datetime.now(timezone.utc)
        _make_event(
            db_session,
            src,
            severity="error",
            message="late arriving error",
            ts=now - timedelta(hours=6),
            created_at=now,
        )
        await db_session.commit()

        from_ts = (now - timedelta(minutes=1)).isoformat()
        to_ts = (now + timedelta(seconds=1)).isoformat()
        resp = await client.get("/api/v1/metrics/top-errors", params={"from": from_ts, "to": to_ts})
        assert resp.status_code == 200
        items = {item["key"]: item["count"] for item in resp.json()["items"]}
        assert items["late arriving error"] == 1


# ---------------------------------------------------------------------------
# /metrics/top-services
# ---------------------------------------------------------------------------

class TestTopServices:
    async def test_returns_200_with_no_events(self, client, db_session):
        resp = await client.get("/api/v1/metrics/top-services")
        assert resp.status_code == 200
        assert resp.json()["items"] == []

    async def test_counts_events_per_service(self, client, db_session):
        src = _make_source(db_session, name="svc-src")
        db_session.add(src)
        await db_session.flush()
        for _ in range(3):
            _make_event(db_session, src, service="nginx", message="req")
        _make_event(db_session, src, service="sshd", message="login")
        await db_session.commit()

        resp = await client.get("/api/v1/metrics/top-services")
        assert resp.status_code == 200
        items = {i["service"]: i["count"] for i in resp.json()["items"]}
        assert items["nginx"] == 3
        assert items["sshd"] == 1

    async def test_top_services_recent_window_uses_ingest_time_for_fresh_historical_events(self, client, db_session):
        src = _make_source(db_session, name="svc-recent-src")
        db_session.add(src)
        await db_session.flush()
        now = datetime.now(timezone.utc)
        _make_event(
            db_session,
            src,
            service="late-service",
            message="late event",
            ts=now - timedelta(hours=3),
            created_at=now,
        )
        await db_session.commit()

        from_ts = (now - timedelta(minutes=1)).isoformat()
        to_ts = (now + timedelta(seconds=1)).isoformat()
        resp = await client.get("/api/v1/metrics/top-services", params={"from": from_ts, "to": to_ts})
        assert resp.status_code == 200
        items = {item["service"]: item["count"] for item in resp.json()["items"]}
        assert items["late-service"] == 1

    async def test_top_services_recent_window_falls_back_for_future_skewed_timestamp(self, client, db_session):
        src = _make_source(db_session, name="svc-future-skew-src")
        db_session.add(src)
        await db_session.flush()
        now = datetime.now(timezone.utc)
        _make_event(
            db_session,
            src,
            service="future-service",
            message="future skewed service event",
            ts=now + timedelta(hours=2),
            created_at=now,
        )
        await db_session.commit()

        from_ts = (now - timedelta(minutes=1)).isoformat()
        to_ts = (now + timedelta(seconds=1)).isoformat()
        resp = await client.get("/api/v1/metrics/top-services", params={"from": from_ts, "to": to_ts})
        assert resp.status_code == 200
        items = {item["service"]: item["count"] for item in resp.json()["items"]}
        assert items["future-service"] == 1


# ---------------------------------------------------------------------------
# /metrics/error-rate
# ---------------------------------------------------------------------------

class TestErrorRate:
    async def test_returns_200_with_no_events(self, client, db_session):
        resp = await client.get("/api/v1/metrics/error-rate")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_events"] == 0
        assert data["error_rate"] == 0.0

    async def test_calculates_error_rate(self, client, db_session):
        src = _make_source(db_session, name="rate-src")
        db_session.add(src)
        await db_session.flush()
        _make_event(db_session, src, severity="info", message="ok")
        _make_event(db_session, src, severity="error", message="fail")
        _make_event(db_session, src, severity="critical", message="crash")
        _make_event(db_session, src, severity="warning", message="warn")
        await db_session.commit()

        resp = await client.get("/api/v1/metrics/error-rate")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_events"] == 4
        assert abs(data["error_rate"] - 0.5) < 0.01

    async def test_error_rate_recent_window_uses_ingest_time_for_fresh_historical_events(self, client, db_session):
        src = _make_source(db_session, name="rate-recent-src")
        db_session.add(src)
        await db_session.flush()
        now = datetime.now(timezone.utc)
        _make_event(
            db_session,
            src,
            severity="error",
            message="recent error by ingest",
            ts=now - timedelta(hours=5),
            created_at=now,
        )
        await db_session.commit()

        from_ts = (now - timedelta(minutes=1)).isoformat()
        to_ts = (now + timedelta(seconds=1)).isoformat()
        resp = await client.get("/api/v1/metrics/error-rate", params={"from": from_ts, "to": to_ts})
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_events"] == 1
        assert data["error_events"] == 1

    async def test_error_rate_recent_window_falls_back_for_future_skewed_timestamp(self, client, db_session):
        src = _make_source(db_session, name="rate-future-skew-src")
        db_session.add(src)
        await db_session.flush()
        now = datetime.now(timezone.utc)
        _make_event(
            db_session,
            src,
            severity="info",
            message="future skewed source timestamp",
            ts=now + timedelta(hours=2),
            created_at=now,
        )
        await db_session.commit()

        from_ts = (now - timedelta(minutes=1)).isoformat()
        to_ts = (now + timedelta(seconds=1)).isoformat()
        resp = await client.get("/api/v1/metrics/error-rate", params={"from": from_ts, "to": to_ts})
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_events"] == 1
        assert data["error_events"] == 0


class TestRollupCoverage:
    async def test_rollup_coverage_start_uses_latest_source_min_bucket(self, db_session):
        src_a = _make_source(db_session, name="rollup-coverage-a")
        src_b = _make_source(db_session, name="rollup-coverage-b")
        db_session.add_all([src_a, src_b])
        await db_session.flush()

        inner_from = datetime(2026, 5, 18, 0, 0, tzinfo=timezone.utc)
        inner_to = datetime(2026, 5, 19, 0, 0, tzinfo=timezone.utc)

        db_session.add(
            EventTimeseriesRollup(
                source_id=src_a.id,
                bucket_start=inner_from,
                total_count=10,
                error_count=1,
            )
        )
        await db_session.flush()
        db_session.add(
            EventTimeseriesRollup(
                source_id=src_b.id,
                bucket_start=inner_from + timedelta(hours=6),
                total_count=4,
                error_count=0,
            )
        )
        await db_session.commit()

        coverage_start = await metrics_api._rollup_coverage_start(
            db_session,
            inner_from,
            inner_to,
            [src_a.id, src_b.id],
        )

        assert coverage_start.replace(tzinfo=timezone.utc) == inner_from + timedelta(hours=6)

    async def test_rollup_coverage_start_falls_back_to_raw_when_source_has_no_rollup(self, db_session):
        src_a = _make_source(db_session, name="rollup-coverage-present")
        src_b = _make_source(db_session, name="rollup-coverage-missing")
        db_session.add_all([src_a, src_b])
        await db_session.flush()

        inner_from = datetime(2026, 5, 18, 0, 0, tzinfo=timezone.utc)
        inner_to = datetime(2026, 5, 19, 0, 0, tzinfo=timezone.utc)

        db_session.add(
            EventTimeseriesRollup(
                source_id=src_a.id,
                bucket_start=inner_from,
                total_count=10,
                error_count=1,
            )
        )
        await db_session.commit()

        coverage_start = await metrics_api._rollup_coverage_start(
            db_session,
            inner_from,
            inner_to,
            [src_a.id, src_b.id],
        )

        assert coverage_start.replace(tzinfo=timezone.utc) == inner_to

    async def test_ensure_rollup_coverage_backfills_missing_prefix_within_limit(self, monkeypatch):
        inner_from = datetime(2026, 5, 18, 0, 0, tzinfo=timezone.utc)
        inner_to = datetime(2026, 5, 19, 0, 0, tzinfo=timezone.utc)
        refresh_calls: list[tuple[datetime, datetime, list[str]]] = []
        coverage_values = iter([inner_from + timedelta(hours=6), inner_from])

        async def fake_coverage_start(_session, _inner_from, _inner_to, _resolved_source_ids):
            return next(coverage_values)

        async def fake_refresh(_session, from_dt, to_dt, resolved_source_ids):
            refresh_calls.append((from_dt, to_dt, resolved_source_ids))

        monkeypatch.setattr(metrics_api, "_rollup_coverage_start", fake_coverage_start)
        monkeypatch.setattr(metrics_api, "_refresh_rollup_15m", fake_refresh)

        coverage_start = await metrics_api._ensure_rollup_coverage(
            None,
            inner_from,
            inner_to,
            ["source-a"],
        )

        assert coverage_start == inner_from
        assert refresh_calls == [(inner_from, inner_to, ["source-a"])]

    async def test_ensure_rollup_coverage_skips_backfill_over_limit(self, monkeypatch):
        inner_from = datetime(2026, 4, 1, 0, 0, tzinfo=timezone.utc)
        inner_to = datetime(2026, 5, 5, 0, 0, tzinfo=timezone.utc)
        refresh_calls: list[tuple[datetime, datetime, list[str]]] = []

        async def fake_coverage_start(_session, _inner_from, _inner_to, _resolved_source_ids):
            return inner_from + timedelta(days=1)

        async def fake_refresh(_session, from_dt, to_dt, resolved_source_ids):
            refresh_calls.append((from_dt, to_dt, resolved_source_ids))

        monkeypatch.setattr(metrics_api, "_rollup_coverage_start", fake_coverage_start)
        monkeypatch.setattr(metrics_api, "_refresh_rollup_15m", fake_refresh)

        coverage_start = await metrics_api._ensure_rollup_coverage(
            None,
            inner_from,
            inner_to,
            ["source-a"],
        )

        assert coverage_start == inner_from + timedelta(days=1)
        assert refresh_calls == []


# ---------------------------------------------------------------------------
# /metrics/volume-check
# ---------------------------------------------------------------------------

class TestVolumeCheck:
    async def test_returns_no_confirmation_below_threshold(self, client, db_session):
        src = _make_source(db_session, name="volume-check-src")
        db_session.add(src)
        await db_session.flush()
        _make_event(db_session, src, message="v1")
        _make_event(db_session, src, message="v2")
        await db_session.commit()

        resp = await client.get("/api/v1/metrics/volume-check?threshold=5")
        assert resp.status_code == 200
        data = resp.json()
        assert data["threshold"] == 5
        assert data["checked_events"] == 2
        assert data["requires_confirmation"] is False
        assert data["capped"] is False

    async def test_requires_confirmation_above_threshold(self, client, db_session):
        src = _make_source(db_session, name="volume-check-over")
        db_session.add(src)
        await db_session.flush()
        for idx in range(4):
            _make_event(db_session, src, message=f"v-over-{idx}")
        await db_session.commit()

        resp = await client.get("/api/v1/metrics/volume-check?threshold=3")
        assert resp.status_code == 200
        data = resp.json()
        assert data["threshold"] == 3
        assert data["checked_events"] == 4
        assert data["requires_confirmation"] is True
        assert data["capped"] is True


class TestTimeoutFallback:
    def test_statement_timeout_is_mapped_to_http_504(self):
        exc = DBAPIError(
            statement="select 1",
            params=None,
            orig=Exception("canceling statement due to statement timeout"),
            hide_parameters=False,
        )

        with pytest.raises(HTTPException) as raised:
            metrics_api._raise_if_statement_timeout(exc)

        assert raised.value.status_code == 504
        assert "Zeitlimit" in str(raised.value.detail)

    def test_non_timeout_db_errors_are_not_rewritten(self):
        exc = DBAPIError(
            statement="select 1",
            params=None,
            orig=Exception("duplicate key value violates unique constraint"),
            hide_parameters=False,
        )

        # Non-timeout DB errors should bubble up unchanged.
        metrics_api._raise_if_statement_timeout(exc)
