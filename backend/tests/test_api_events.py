"""Integration tests for Events API (/api/v1/events)."""
from __future__ import annotations

import pytest
from datetime import datetime, timedelta, timezone
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.events import _decode_stream_cursor, _encode_stream_cursor, _stream_bootstrap_cursor, _stream_events_stmt_after
from app.domain.models import Event, Source


pytestmark = pytest.mark.asyncio


async def _seed_source(db: AsyncSession, name: str = "test-src", path: str = "/var/log/test.log") -> Source:
    src = Source(name=name, type="file", config_json={"path": path}, enabled=True)
    db.add(src)
    await db.flush()
    await db.refresh(src)
    return src


async def _seed_event(db: AsyncSession, source_id: str, **kwargs) -> Event:
    e = Event(
        source_id=source_id,
        timestamp=kwargs.get("timestamp", datetime.now(timezone.utc)),
        severity=kwargs.get("severity", "info"),
        message=kwargs.get("message", "test message"),
        service=kwargs.get("service", None),
        host=kwargs.get("host", None),
        environment=kwargs.get("environment", None),
        event_type=kwargs.get("event_type", None),
        fields_json=kwargs.get("fields_json", {}),
        fingerprint=kwargs.get("fingerprint", None),
        created_at=kwargs.get("created_at"),
    )
    db.add(e)
    await db.flush()
    return e


class TestEventsAPI:
    async def test_list_events_empty(self, client: AsyncClient):
        resp = await client.get("/api/v1/events")
        assert resp.status_code == 200
        data = resp.json()
        assert "items" in data
        assert data["items"] == []

    async def test_list_events_returns_seeded_data(self, client: AsyncClient, db_session: AsyncSession):
        src = await _seed_source(db_session)
        await _seed_event(db_session, src.id, message="hello world", severity="info")
        await db_session.commit()

        resp = await client.get("/api/v1/events")
        assert resp.status_code == 200
        items = resp.json()["items"]
        assert len(items) == 1
        assert items[0]["message"] == "hello world"

    async def test_filter_by_severity(self, client: AsyncClient, db_session: AsyncSession):
        src = await _seed_source(db_session)
        await _seed_event(db_session, src.id, severity="error", message="boom")
        await _seed_event(db_session, src.id, severity="info", message="ok")
        await db_session.commit()

        resp = await client.get("/api/v1/events?severity=error")
        items = resp.json()["items"]
        assert len(items) == 1
        assert items[0]["severity"] == "error"

    async def test_filter_by_source_id(self, client: AsyncClient, db_session: AsyncSession):
        src1 = await _seed_source(db_session, "src1")
        src2 = await _seed_source(db_session, "src2")
        await _seed_event(db_session, src1.id, message="from-src1")
        await _seed_event(db_session, src2.id, message="from-src2")
        await db_session.commit()

        resp = await client.get(f"/api/v1/events?source_id={src1.id}")
        items = resp.json()["items"]
        assert len(items) == 1
        assert items[0]["message"] == "from-src1"

    async def test_filter_by_multiple_source_ids(self, client: AsyncClient, db_session: AsyncSession):
        src1 = await _seed_source(db_session, "src1", "/var/log/src1.log")
        src2 = await _seed_source(db_session, "src2", "/var/log/src2.log")
        src3 = await _seed_source(db_session, "src3", "/var/log/src3.log")
        await _seed_event(db_session, src1.id, message="from-src1")
        await _seed_event(db_session, src2.id, message="from-src2")
        await _seed_event(db_session, src3.id, message="from-src3")
        await db_session.commit()

        resp = await client.get(f"/api/v1/events?source_ids={src1.id},{src2.id}")
        items = resp.json()["items"]
        assert {item["message"] for item in items} == {"from-src1", "from-src2"}

    async def test_filter_by_source_paths(self, client: AsyncClient, db_session: AsyncSession):
        src1 = await _seed_source(db_session, "src1", "/var/log/app.log")
        src2 = await _seed_source(db_session, "src2", "/var/log/db.log")
        await _seed_event(db_session, src1.id, message="from-app")
        await _seed_event(db_session, src2.id, message="from-db")
        await db_session.commit()

        resp = await client.get("/api/v1/events?source_paths=/var/log/app.log")
        items = resp.json()["items"]
        assert len(items) == 1
        assert items[0]["message"] == "from-app"

    async def test_filter_by_full_text_query(self, client: AsyncClient, db_session: AsyncSession):
        src = await _seed_source(db_session)
        await _seed_event(db_session, src.id, message="OOM killer activated on node1")
        await _seed_event(db_session, src.id, message="disk usage normal")
        await db_session.commit()

        resp = await client.get("/api/v1/events?q=OOM")
        items = resp.json()["items"]
        assert len(items) == 1
        assert "OOM" in items[0]["message"]

    async def test_filter_by_service_is_partial_and_case_insensitive(self, client: AsyncClient, db_session: AsyncSession):
        src = await _seed_source(db_session)
        await _seed_event(db_session, src.id, service="log-analyzer-backend", message="startup")
        await _seed_event(db_session, src.id, service="sshd", message="login")
        await db_session.commit()

        resp = await client.get("/api/v1/events?service=ANALYZER")
        items = resp.json()["items"]
        assert len(items) == 1
        assert items[0]["service"] == "log-analyzer-backend"

    async def test_filter_by_host_is_partial_and_case_insensitive(self, client: AsyncClient, db_session: AsyncSession):
        src = await _seed_source(db_session)
        await _seed_event(db_session, src.id, host="Rechenknecht", message="m1")
        await _seed_event(db_session, src.id, host="db-node-1", message="m2")
        await db_session.commit()

        resp = await client.get("/api/v1/events?host=KNECHT")
        items = resp.json()["items"]
        assert len(items) == 1
        assert items[0]["host"] == "Rechenknecht"

    async def test_limit_parameter(self, client: AsyncClient, db_session: AsyncSession):
        src = await _seed_source(db_session)
        for i in range(10):
            await _seed_event(db_session, src.id, message=f"event {i}")
        await db_session.commit()

        resp = await client.get("/api/v1/events?limit=3")
        assert resp.status_code == 200
        assert len(resp.json()["items"]) == 3

    async def test_time_range_includes_recently_ingested_events_with_historical_log_timestamps(self, client: AsyncClient, db_session: AsyncSession):
        src = await _seed_source(db_session)
        now = datetime.now(timezone.utc)
        await _seed_event(
            db_session,
            src.id,
            message="historical timestamp, fresh ingest",
            timestamp=now - timedelta(hours=12),
            created_at=now,
        )
        await db_session.commit()

        from_ts = (now - timedelta(minutes=1)).isoformat()
        to_ts = (now + timedelta(seconds=1)).isoformat()
        resp = await client.get("/api/v1/events", params={"from": from_ts, "to": to_ts})
        assert resp.status_code == 200
        items = resp.json()["items"]
        assert len(items) == 1
        assert items[0]["message"] == "historical timestamp, fresh ingest"

    async def test_short_time_range_includes_events_by_log_timestamp(self, client: AsyncClient, db_session: AsyncSession):
        src = await _seed_source(db_session)
        now = datetime.now(timezone.utc)
        await _seed_event(
            db_session,
            src.id,
            message="recent log timestamp, older ingest",
            timestamp=now - timedelta(seconds=30),
            created_at=now - timedelta(minutes=10),
        )
        await db_session.commit()

        from_ts = (now - timedelta(minutes=1)).isoformat()
        to_ts = now.isoformat()
        resp = await client.get("/api/v1/events", params={"from": from_ts, "to": to_ts, "source_id": src.id})
        assert resp.status_code == 200
        items = resp.json()["items"]
        assert len(items) == 1
        assert items[0]["message"] == "recent log timestamp, older ingest"

    async def test_time_range_deduplicates_events_matching_timestamp_and_created_at(self, client: AsyncClient, db_session: AsyncSession):
        src = await _seed_source(db_session)
        now = datetime.now(timezone.utc)
        await _seed_event(
            db_session,
            src.id,
            message="matches both clocks",
            timestamp=now - timedelta(seconds=20),
            created_at=now - timedelta(seconds=10),
        )
        await db_session.commit()

        from_ts = (now - timedelta(minutes=1)).isoformat()
        to_ts = now.isoformat()
        resp = await client.get("/api/v1/events", params={"from": from_ts, "to": to_ts, "source_id": src.id})
        assert resp.status_code == 200
        items = resp.json()["items"]
        assert [item["message"] for item in items] == ["matches both clocks"]

    async def test_events_are_sorted_by_ingest_time_for_recent_views(self, client: AsyncClient, db_session: AsyncSession):
        src = await _seed_source(db_session)
        now = datetime.now(timezone.utc)
        await _seed_event(
            db_session,
            src.id,
            message="older ingest",
            timestamp=now,
            created_at=now - timedelta(seconds=30),
        )
        await _seed_event(
            db_session,
            src.id,
            message="newer ingest",
            timestamp=now - timedelta(hours=1),
            created_at=now,
        )
        await db_session.commit()

        resp = await client.get("/api/v1/events")
        assert resp.status_code == 200
        items = resp.json()["items"]
        assert [item["message"] for item in items[:2]] == ["newer ingest", "older ingest"]

    async def test_get_event_by_id(self, client: AsyncClient, db_session: AsyncSession):
        src = await _seed_source(db_session)
        event = await _seed_event(db_session, src.id, message="specific event")
        await db_session.commit()

        resp = await client.get(f"/api/v1/events/{event.id}")
        assert resp.status_code == 200
        assert resp.json()["message"] == "specific event"

    async def test_get_nonexistent_event_returns_404(self, client: AsyncClient):
        resp = await client.get("/api/v1/events/00000000-0000-0000-0000-000000000000")
        assert resp.status_code == 404

    async def test_limit_too_high_returns_422(self, client: AsyncClient):
        resp = await client.get("/api/v1/events?limit=9999")
        assert resp.status_code == 422

    async def test_event_stream_starts_at_current_time_and_emits_only_new_events(self, client: AsyncClient, db_session: AsyncSession):
        src = await _seed_source(db_session)
        now = datetime.now(timezone.utc)
        historical = await _seed_event(
            db_session,
            src.id,
            message="historical event",
            timestamp=now,
            created_at=now,
        )
        await db_session.commit()

        cursor = await _stream_bootstrap_cursor(db_session)
        assert cursor is not None
        encoded = _encode_stream_cursor(cursor[0], cursor[1])
        decoded = _decode_stream_cursor(encoded)
        assert decoded == cursor

        result = await db_session.execute(_stream_events_stmt_after(cursor))
        rows = list(result.scalars().all())
        rows_without_bootstrap = [row for row in rows if row.id != historical.id]
        assert rows_without_bootstrap == []

        fresh = await _seed_event(
            db_session,
            src.id,
            message="fresh live event",
            event_type="syslog",
            timestamp=now + timedelta(seconds=1),
            created_at=now + timedelta(seconds=1),
        )
        await db_session.commit()

        result = await db_session.execute(_stream_events_stmt_after(cursor))
        rows = [row for row in result.scalars().all() if row.id != historical.id]
        assert [row.id for row in rows] == [fresh.id]

    async def test_event_stream_cursor_uses_created_at_and_id_tie_break(self, db_session: AsyncSession):
        src = await _seed_source(db_session, name="stream-tie-break")
        shared_created = datetime(2026, 5, 19, 10, 0, 0, tzinfo=timezone.utc)

        first = await _seed_event(
            db_session,
            src.id,
            message="first",
            timestamp=shared_created,
            created_at=shared_created,
        )
        second = await _seed_event(
            db_session,
            src.id,
            message="second",
            timestamp=shared_created,
            created_at=shared_created,
        )
        third = await _seed_event(
            db_session,
            src.id,
            message="third",
            timestamp=shared_created,
            created_at=shared_created,
        )
        await db_session.commit()

        events_sorted = sorted([first, second, third], key=lambda event: event.id)
        cursor = (shared_created, events_sorted[1].id)

        result = await db_session.execute(_stream_events_stmt_after(cursor))
        rows = list(result.scalars().all())

        assert [row.id for row in rows] == [events_sorted[2].id]

    async def test_provider_query_rejects_invalid_value(self, client: AsyncClient):
        resp = await client.get("/api/v1/events?provider=invalid")
        assert resp.status_code == 422

    async def test_provider_query_elastic_returns_503_when_disabled(self, client: AsyncClient):
        resp = await client.get("/api/v1/events?provider=elastic")
        assert resp.status_code == 503

    async def test_provider_auto_falls_back_to_postgres(self, client: AsyncClient, db_session: AsyncSession):
        src = await _seed_source(db_session)
        await _seed_event(db_session, src.id, message="fallback works")
        await db_session.commit()

        resp = await client.get("/api/v1/events?provider=auto")
        assert resp.status_code == 200
        assert resp.headers.get("x-events-provider") == "postgres"
        assert any(item["message"] == "fallback works" for item in resp.json()["items"])
