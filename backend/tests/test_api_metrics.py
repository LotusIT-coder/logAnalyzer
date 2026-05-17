"""Tests for metrics API endpoints (Point 3: Dashboard echte Daten).

These tests verify that the metrics endpoints return real data from the DB,
and that the default behaviour (no source filter) returns aggregated totals.

The timeseries endpoint uses date_trunc (PostgreSQL). For SQLite we need
a fallback; the implementation must handle both gracefully.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.models import Event, Source


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

    async def test_recent_window_uses_event_timestamp_for_historical_events(self, client, db_session):
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
        assert sum(point["count"] for point in resp.json()["points"]) == 0


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

    async def test_top_errors_recent_window_uses_event_timestamp(self, client, db_session):
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
        assert resp.json()["items"] == []


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

    async def test_top_services_recent_window_uses_event_timestamp(self, client, db_session):
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
        assert "late-service" not in items


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

    async def test_error_rate_recent_window_uses_event_timestamp(self, client, db_session):
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
        assert data["total_events"] == 0
        assert data["error_events"] == 0


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
