"""Integration tests for Incidents API (/api/v1/incidents)."""
from __future__ import annotations

import pytest
from datetime import datetime, timezone
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.models import Incident


pytestmark = pytest.mark.asyncio


async def _seed_incident(db: AsyncSession, **kwargs) -> Incident:
    now = datetime.now(timezone.utc)
    inc = Incident(
        title=kwargs.get("title", "Test incident"),
        status=kwargs.get("status", "open"),
        severity=kwargs.get("severity", "warning"),
        first_seen=kwargs.get("first_seen", now),
        last_seen=kwargs.get("last_seen", now),
        event_count=kwargs.get("event_count", 3),
        mitre_techniques_json=kwargs.get("mitre_techniques_json"),
        mitre_tactic=kwargs.get("mitre_tactic"),
        confidence_score=kwargs.get("confidence_score"),
        confidence_rationale=kwargs.get("confidence_rationale"),
        tags_json=[],
    )
    db.add(inc)
    await db.flush()
    await db.refresh(inc)
    return inc


class TestIncidentsAPI:
    async def test_list_incidents_empty(self, client: AsyncClient):
        resp = await client.get("/api/v1/incidents")
        assert resp.status_code == 200
        assert resp.json()["items"] == []

    async def test_list_incidents_returns_seeded(self, client: AsyncClient, db_session: AsyncSession):
        await _seed_incident(db_session, title="OOM spike")
        await db_session.commit()

        resp = await client.get("/api/v1/incidents")
        items = resp.json()["items"]
        assert len(items) == 1
        assert items[0]["title"] == "OOM spike"

    async def test_filter_by_status(self, client: AsyncClient, db_session: AsyncSession):
        await _seed_incident(db_session, status="open")
        await _seed_incident(db_session, status="resolved")
        await db_session.commit()

        resp = await client.get("/api/v1/incidents?status=open")
        items = resp.json()["items"]
        assert len(items) == 1
        assert items[0]["status"] == "open"

    async def test_filter_by_invalid_status_returns_422(self, client: AsyncClient):
        resp = await client.get("/api/v1/incidents?status=banana")
        assert resp.status_code == 422

    async def test_filter_by_severity(self, client: AsyncClient, db_session: AsyncSession):
        await _seed_incident(db_session, severity="critical")
        await _seed_incident(db_session, severity="warning")
        await db_session.commit()

        resp = await client.get("/api/v1/incidents?severity=critical")
        items = resp.json()["items"]
        assert len(items) == 1
        assert items[0]["severity"] == "critical"

    async def test_patch_incident_status(self, client: AsyncClient, db_session: AsyncSession):
        inc = await _seed_incident(db_session, status="open")
        await db_session.commit()

        resp = await client.patch(f"/api/v1/incidents/{inc.id}", json={"status": "investigating"})
        assert resp.status_code == 200
        assert resp.json()["status"] == "investigating"

    async def test_patch_to_resolved(self, client: AsyncClient, db_session: AsyncSession):
        inc = await _seed_incident(db_session, status="investigating")
        await db_session.commit()

        resp = await client.patch(f"/api/v1/incidents/{inc.id}", json={"status": "resolved"})
        assert resp.status_code == 200
        assert resp.json()["status"] == "resolved"

    async def test_patch_to_archived(self, client: AsyncClient, db_session: AsyncSession):
        inc = await _seed_incident(db_session, status="resolved")
        await db_session.commit()

        resp = await client.patch(f"/api/v1/incidents/{inc.id}", json={"status": "archived"})
        assert resp.status_code == 200
        assert resp.json()["status"] == "archived"

    async def test_patch_to_invalid_status_returns_422(self, client: AsyncClient, db_session: AsyncSession):
        inc = await _seed_incident(db_session)
        await db_session.commit()

        resp = await client.patch(f"/api/v1/incidents/{inc.id}", json={"status": "invalid_state"})
        assert resp.status_code == 422

    async def test_patch_nonexistent_returns_404(self, client: AsyncClient):
        resp = await client.patch(
            "/api/v1/incidents/00000000-0000-0000-0000-000000000000",
            json={"status": "resolved"}
        )
        assert resp.status_code == 404

    async def test_archive_endpoint_sets_status_archived(self, client: AsyncClient, db_session: AsyncSession):
        inc = await _seed_incident(db_session, status="open")
        await db_session.commit()

        resp = await client.post(f"/api/v1/incidents/{inc.id}/archive")
        assert resp.status_code == 200
        assert resp.json()["status"] == "archived"

    async def test_archive_nonexistent_returns_404(self, client: AsyncClient):
        resp = await client.post("/api/v1/incidents/00000000-0000-0000-0000-000000000000/archive")
        assert resp.status_code == 404

    async def test_delete_incident(self, client: AsyncClient, db_session: AsyncSession):
        inc = await _seed_incident(db_session, status="open")
        await db_session.commit()

        resp = await client.delete(f"/api/v1/incidents/{inc.id}")
        assert resp.status_code == 204

        after = await client.get("/api/v1/incidents")
        ids = [item["id"] for item in after.json()["items"]]
        assert str(inc.id) not in ids

    async def test_delete_nonexistent_returns_404(self, client: AsyncClient):
        resp = await client.delete("/api/v1/incidents/00000000-0000-0000-0000-000000000000")
        assert resp.status_code == 404

    async def test_get_incident_by_id(self, client: AsyncClient, db_session: AsyncSession):
        inc = await _seed_incident(db_session, title="disk full")
        await db_session.commit()

        resp = await client.get(f"/api/v1/incidents/{inc.id}")
        assert resp.status_code == 200
        assert resp.json()["title"] == "disk full"

    async def test_get_incident_returns_confidence_fields(self, client: AsyncClient, db_session: AsyncSession):
        inc = await _seed_incident(
            db_session,
            title="powershell chain",
            confidence_score=0.93,
            confidence_rationale="threshold=2/1, sequence_completeness=1.00, signal_strength=0.95",
        )
        await db_session.commit()

        resp = await client.get(f"/api/v1/incidents/{inc.id}")
        assert resp.status_code == 200
        assert resp.json()["confidence_score"] == 0.93
        assert "sequence_completeness" in resp.json()["confidence_rationale"]

    async def test_get_incident_returns_mitre_fields(self, client: AsyncClient, db_session: AsyncSession):
        inc = await _seed_incident(
            db_session,
            title="mitre mapped incident",
            mitre_techniques_json=["T1110", "T1078"],
            mitre_tactic="credential-access",
        )
        await db_session.commit()

        resp = await client.get(f"/api/v1/incidents/{inc.id}")
        assert resp.status_code == 200
        assert resp.json()["mitre_techniques"] == ["T1110", "T1078"]
        assert resp.json()["mitre_tactic"] == "credential-access"

    async def test_get_mitre_coverage_empty(self, client: AsyncClient):
        resp = await client.get("/api/v1/incidents/mitre-coverage")
        assert resp.status_code == 200
        body = resp.json()
        assert body["items"] == []
        assert body["mapped_rules"] == 0
        assert body["mapped_incidents"] == 0

    async def test_get_mitre_coverage_aggregates_counts(self, client: AsyncClient, db_session: AsyncSession):
        create_rule_payload = {
            "name": "MITRE Rule",
            "description": "Mapped rule",
            "condition": {"severity": "error"},
            "mitre_techniques": ["T1110", "T1078"],
            "mitre_tactic": "credential-access",
            "threshold": 1,
            "window_seconds": 300,
            "severity": "warning",
            "enabled": True,
        }
        rule_resp = await client.post("/api/v1/rules", json=create_rule_payload)
        assert rule_resp.status_code == 201

        await _seed_incident(
            db_session,
            title="mitre-incident-1",
            mitre_techniques_json=["T1110"],
            mitre_tactic="credential-access",
        )
        await _seed_incident(
            db_session,
            title="mitre-incident-2",
            mitre_techniques_json=["T1110", "T1059.001"],
            mitre_tactic="execution",
        )
        await db_session.commit()

        resp = await client.get("/api/v1/incidents/mitre-coverage")
        assert resp.status_code == 200
        body = resp.json()
        assert body["mapped_rules"] == 1
        assert body["mapped_incidents"] == 2

        by_technique = {item["technique_id"]: item for item in body["items"]}
        assert by_technique["T1110"]["rule_count"] == 1
        assert by_technique["T1110"]["incident_count"] == 2
        assert by_technique["T1110"]["tactic"] == "credential-access"
        assert by_technique["T1059.001"]["rule_count"] == 0
        assert by_technique["T1059.001"]["incident_count"] == 1
