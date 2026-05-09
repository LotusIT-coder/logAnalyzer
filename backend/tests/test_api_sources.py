"""Integration tests for Sources API (/api/v1/sources).

Uses an in-memory SQLite DB via the conftest.py fixtures — no real PostgreSQL needed.
PostgreSQL-specific constructs (JSONB, UUID columns) are tested at a higher level;
for SQLite the ORM falls back to JSON/TEXT columns automatically.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
import pytest_asyncio
from httpx import AsyncClient

from app.domain.models import Event, RawLog, Source


pytestmark = pytest.mark.asyncio


class TestSourcesCRUD:
    async def test_list_sources_empty(self, client: AsyncClient):
        resp = await client.get("/api/v1/sources")
        assert resp.status_code == 200
        data = resp.json()
        assert "items" in data
        assert data["items"] == []

    async def test_create_source(self, client: AsyncClient):
        payload = {
            "name": "syslog",
            "type": "file",
            "config": {"path": "/var/log/syslog"},
            "enabled": True,
        }
        resp = await client.post("/api/v1/sources", json=payload)
        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "syslog"
        assert body["type"] == "file"
        assert "id" in body
        return body["id"]

    async def test_list_sources_after_create(self, client: AsyncClient):
        await client.post("/api/v1/sources", json={
            "name": "auth.log", "type": "file",
            "config": {"path": "/var/log/auth.log"}, "enabled": True,
        })
        resp = await client.get("/api/v1/sources")
        assert resp.status_code == 200
        items = resp.json()["items"]
        assert len(items) == 1
        assert items[0]["name"] == "auth.log"

    async def test_patch_source_name(self, client: AsyncClient):
        create = await client.post("/api/v1/sources", json={
            "name": "old-name", "type": "file",
            "config": {"path": "/var/log/test.log"}, "enabled": True,
        })
        src_id = create.json()["id"]

        resp = await client.patch(f"/api/v1/sources/{src_id}", json={"name": "new-name"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "new-name"

    async def test_patch_source_enabled_false(self, client: AsyncClient):
        create = await client.post("/api/v1/sources", json={
            "name": "src", "type": "file",
            "config": {"path": "/var/log/x.log"}, "enabled": True,
        })
        src_id = create.json()["id"]

        resp = await client.patch(f"/api/v1/sources/{src_id}", json={"enabled": False})
        assert resp.status_code == 200
        assert resp.json()["enabled"] is False

    async def test_patch_nonexistent_returns_404(self, client: AsyncClient):
        resp = await client.patch("/api/v1/sources/00000000-0000-0000-0000-000000000000", json={"name": "x"})
        assert resp.status_code == 404

    async def test_delete_source(self, client: AsyncClient):
        create = await client.post("/api/v1/sources", json={
            "name": "to-delete", "type": "file",
            "config": {"path": "/tmp/del.log"}, "enabled": True,
        })
        src_id = create.json()["id"]

        resp = await client.delete(f"/api/v1/sources/{src_id}")
        assert resp.status_code == 204

        # Verify gone
        list_resp = await client.get("/api/v1/sources")
        items = list_resp.json()["items"]
        assert not any(s["id"] == src_id for s in items)

    async def test_delete_nonexistent_returns_404(self, client: AsyncClient):
        resp = await client.delete("/api/v1/sources/00000000-0000-0000-0000-000000000000")
        assert resp.status_code == 404

    async def test_create_source_invalid_type(self, client: AsyncClient):
        payload = {"name": "bad", "type": "invalid_type", "config": {}, "enabled": True}
        resp = await client.post("/api/v1/sources", json=payload)
        assert resp.status_code == 422

    async def test_source_test_supports_regex_path(self, client: AsyncClient, tmp_path):
        logs_dir = tmp_path / "lotus-logs"
        logs_dir.mkdir()
        (logs_dir / "lotus-client-2026-05-01.log").write_text("hello\n", encoding="utf-8")

        create = await client.post("/api/v1/sources", json={
            "name": "lotus-client",
            "type": "file",
            "config": {
                "path": str(logs_dir / r"lotus-client-[0-9]{4}-[0-9]{2}-[0-9]{2}\.log"),
                "path_regex": True,
            },
            "enabled": True,
        })
        assert create.status_code == 201
        source_id = create.json()["id"]

        tested = await client.post(f"/api/v1/sources/{source_id}/test")
        assert tested.status_code == 200
        body = tested.json()
        assert body["ok"] is True
        assert "File accessible:" in (body.get("details") or "")

    async def test_source_status_contains_ingestion_and_event_timestamps(self, client: AsyncClient, db_session):
        src = Source(
            name="status-src",
            type="file",
            config_json={"path": "/tmp/status.log"},
            enabled=True,
        )
        db_session.add(src)
        await db_session.flush()

        db_session.add(
            RawLog(
                source_id=src.id,
                raw_line="line",
                raw_hash="hash",
                cursor="12",
            )
        )
        db_session.add(
            Event(
                source_id=src.id,
                timestamp=datetime.now(timezone.utc),
                severity="info",
                message="status event",
                service="svc",
                host="host",
                fields_json={},
            )
        )
        await db_session.commit()

        resp = await client.get(f"/api/v1/sources/status?source_ids={src.id}")
        assert resp.status_code == 200
        items = resp.json().get("items", [])
        assert len(items) == 1
        assert items[0]["source_id"] == str(src.id)
        assert items[0]["last_ingested_at"] is not None
        assert items[0]["last_event_timestamp"] is not None
