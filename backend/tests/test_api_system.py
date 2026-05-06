"""Integration tests for system/health endpoints."""
from __future__ import annotations

import pytest
from httpx import AsyncClient


pytestmark = pytest.mark.asyncio


class TestSystemEndpoints:
    async def test_health_returns_200(self, client: AsyncClient):
        resp = await client.get("/api/v1/health")
        assert resp.status_code == 200

    async def test_health_contains_status(self, client: AsyncClient):
        resp = await client.get("/api/v1/health")
        body = resp.json()
        assert "status" in body
        assert body["status"] in ("ok", "healthy", "degraded")

    async def test_version_endpoint(self, client: AsyncClient):
        resp = await client.get("/api/v1/version")
        assert resp.status_code == 200
        assert "api_version" in resp.json()

    async def test_404_for_unknown_path(self, client: AsyncClient):
        resp = await client.get("/api/v1/does-not-exist")
        assert resp.status_code == 404
