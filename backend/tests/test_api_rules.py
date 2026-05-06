"""Integration tests for Rules API (/api/v1/rules)."""
from __future__ import annotations

import pytest
from httpx import AsyncClient


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
