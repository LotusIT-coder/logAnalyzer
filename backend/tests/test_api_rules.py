"""Integration tests for Rules API (/api/v1/rules)."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from httpx import AsyncClient

from app.domain.models import Event, Source


pytestmark = pytest.mark.asyncio

_VALID_RULE = {
    "name": "High error rate",
    "description": "Fires when errors spike",
    "condition": {"severity": "error"},
    "threshold": 10,
    "window_seconds": 300,
    "severity": "warning",
    "enabled": True,
}


class TestRulesCRUD:
    async def test_list_rules_empty(self, client: AsyncClient):
        resp = await client.get("/api/v1/rules")
        assert resp.status_code == 200
        assert resp.json()["items"] == []

    async def test_create_rule(self, client: AsyncClient):
        resp = await client.post("/api/v1/rules", json=_VALID_RULE)
        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "High error rate"
        assert body["threshold"] == 10
        assert body["window_seconds"] == 300
        assert "id" in body

    async def test_list_rules_after_create(self, client: AsyncClient):
        await client.post("/api/v1/rules", json=_VALID_RULE)
        resp = await client.get("/api/v1/rules")
        assert len(resp.json()["items"]) == 1

    async def test_patch_rule_threshold(self, client: AsyncClient):
        create = await client.post("/api/v1/rules", json=_VALID_RULE)
        rule_id = create.json()["id"]

        resp = await client.patch(f"/api/v1/rules/{rule_id}", json={"threshold": 5})
        assert resp.status_code == 200
        assert resp.json()["threshold"] == 5

    async def test_patch_rule_enabled(self, client: AsyncClient):
        create = await client.post("/api/v1/rules", json=_VALID_RULE)
        rule_id = create.json()["id"]

        resp = await client.patch(f"/api/v1/rules/{rule_id}", json={"enabled": False})
        assert resp.status_code == 200
        assert resp.json()["enabled"] is False

    async def test_patch_nonexistent_returns_404(self, client: AsyncClient):
        resp = await client.patch(
            "/api/v1/rules/00000000-0000-0000-0000-000000000000",
            json={"threshold": 1}
        )
        assert resp.status_code == 404

    async def test_delete_rule(self, client: AsyncClient):
        create = await client.post("/api/v1/rules", json=_VALID_RULE)
        rule_id = create.json()["id"]

        resp = await client.delete(f"/api/v1/rules/{rule_id}")
        assert resp.status_code == 204

        list_resp = await client.get("/api/v1/rules")
        assert list_resp.status_code == 200
        items = list_resp.json()["items"]
        assert not any(rule["id"] == rule_id for rule in items)

    async def test_delete_nonexistent_returns_404(self, client: AsyncClient):
        resp = await client.delete("/api/v1/rules/00000000-0000-0000-0000-000000000000")
        assert resp.status_code == 404

    async def test_create_rule_missing_required_fields(self, client: AsyncClient):
        resp = await client.post("/api/v1/rules", json={"name": "incomplete"})
        assert resp.status_code == 422

    async def test_dry_run_no_events(self, client: AsyncClient):
        create = await client.post("/api/v1/rules", json=_VALID_RULE)
        rule_id = create.json()["id"]

        resp = await client.post(f"/api/v1/rules/{rule_id}/dry-run", json={})
        assert resp.status_code == 200
        body = resp.json()
        assert "matched_events" in body
        assert "would_create_incident" in body
        assert body["matched_events"] == 0
        assert body["would_create_incident"] is False

    async def test_dry_run_matches_fields_json_condition(self, client: AsyncClient, db_session):
        source = Source(
            name="auth-log",
            type="file",
            enabled=True,
            config_json={"path": "/var/log/auth.log"},
        )
        db_session.add(source)
        await db_session.flush()

        db_session.add(
            Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="warning",
                message="Failed password for root from 10.0.0.5 port 22 ssh2",
                service="sshd",
                host="srv-auth-01",
                environment="test",
                event_type="auth",
                fields_json={"username": "root", "source_ip": "10.0.0.5", "event_action": "failed_password"},
                fingerprint="auth-failed-root-1",
            )
        )
        await db_session.commit()

        create = await client.post(
            "/api/v1/rules",
            json={
                "name": "SSH Failed Password Burst",
                "description": "Correlates failed password attempts for the same user",
                "condition": {"service": "sshd", "field": "event_action", "value": "failed_password"},
                "threshold": 1,
                "window_seconds": 300,
                "severity": "warning",
                "enabled": True,
            },
        )
        rule_id = create.json()["id"]

        resp = await client.post(f"/api/v1/rules/{rule_id}/dry-run", json={})
        assert resp.status_code == 200
        assert resp.json()["matched_events"] == 1
        assert resp.json()["would_create_incident"] is True

    async def test_dry_run_matches_deployment_condition(self, client: AsyncClient, db_session):
        source = Source(
            name="deploy-log",
            type="file",
            enabled=True,
            config_json={"path": "/var/log/deploy.log"},
        )
        db_session.add(source)
        await db_session.flush()

        db_session.add(
            Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="info",
                message="Deployment finished for release 2026.05.06-1",
                service="deploy-agent",
                host="srv-app-01",
                environment="production",
                event_type="deployment",
                fields_json={"release": "2026.05.06-1", "deployment_status": "completed"},
                fingerprint="deploy-prod-20260506-1",
            )
        )
        await db_session.commit()

        create = await client.post(
            "/api/v1/rules",
            json={
                "name": "Production Deployment Seen",
                "description": "Matches deployment events in production",
                "condition": {"event_type": "deployment", "environment": "production"},
                "threshold": 1,
                "window_seconds": 300,
                "severity": "info",
                "enabled": True,
            },
        )
        rule_id = create.json()["id"]

        resp = await client.post(f"/api/v1/rules/{rule_id}/dry-run", json={})
        assert resp.status_code == 200
        assert resp.json()["matched_events"] == 1
        assert resp.json()["would_create_incident"] is True
