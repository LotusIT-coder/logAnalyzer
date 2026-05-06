"""Unit tests for the rule engine condition evaluator and evaluation logic."""
from __future__ import annotations

import pytest
import pytest_asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

from app.services.rule_engine import _matches_condition, evaluate_rule
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
