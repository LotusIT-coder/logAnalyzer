"""TDD tests for RuleSchedulerService (Point 2: Rule Engine Auto-Trigger).

The RuleSchedulerService is a background asyncio task that periodically calls
run_rule_engine() to evaluate all enabled rules and create incidents.

RED phase: all tests fail until app/services/rule_scheduler.py is created.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _make_mock_session():
    """Return an AsyncMock configured as an async context manager (session)."""
    mock_session = AsyncMock()
    mock_session.add = MagicMock()
    mock_session.info = {}
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)
    return mock_session


class TestRuleSchedulerLifecycle:
    """Start / stop lifecycle mirrors WatcherService pattern."""

    async def test_service_starts_and_can_be_stopped(self):
        from app.services.rule_scheduler import RuleSchedulerService

        svc = RuleSchedulerService(interval_seconds=0.05)
        assert not svc.running

        await svc.start()
        assert svc.running

        await svc.stop()
        assert not svc.running

    async def test_start_is_idempotent(self):
        from app.services.rule_scheduler import RuleSchedulerService

        svc = RuleSchedulerService(interval_seconds=0.05)
        await svc.start()
        task1 = svc._task
        await svc.start()  # second call — must not spawn a new task
        assert svc._task is task1
        await svc.stop()

    async def test_stop_without_start_is_safe(self):
        from app.services.rule_scheduler import RuleSchedulerService

        svc = RuleSchedulerService(interval_seconds=0.05)
        await svc.stop()  # must not raise
        assert not svc.running


class TestRuleSchedulerPolling:
    """Verify that run_rule_engine is called on each tick."""

    async def test_run_rule_engine_is_called(self):
        """run_rule_engine should be called at least once after one tick."""
        from app.services.rule_scheduler import RuleSchedulerService

        mock_run = AsyncMock(return_value=[])
        mock_run_anomaly = AsyncMock(return_value=MagicMock(incident_created=False))
        mock_run_heuristics = AsyncMock(return_value=MagicMock(incidents_created=0))
        mock_session = _make_mock_session()
        mock_factory = MagicMock(return_value=mock_session)

        with (
            patch("app.services.rule_scheduler.run_rule_engine", mock_run),
            patch("app.services.rule_scheduler.run_event_volume_anomaly_detection", mock_run_anomaly),
            patch("app.services.rule_scheduler.run_realtime_heuristics", mock_run_heuristics),
            patch("app.services.rule_scheduler.get_session_factory", return_value=mock_factory),
        ):
            svc = RuleSchedulerService(interval_seconds=0.05)
            await svc.start()
            await asyncio.sleep(0.12)
            await svc.stop()

        assert mock_run.call_count >= 1

    async def test_run_event_volume_anomaly_detection_is_called(self):
        """Anomaly detection should run alongside the rule engine on each tick."""
        from app.services.rule_scheduler import RuleSchedulerService

        mock_run_rules = AsyncMock(return_value=[])
        mock_run_anomaly = AsyncMock(return_value=MagicMock(incident_created=False))
        mock_run_heuristics = AsyncMock(return_value=MagicMock(incidents_created=0))
        mock_session = _make_mock_session()
        mock_factory = MagicMock(return_value=mock_session)

        with (
            patch("app.services.rule_scheduler.run_rule_engine", mock_run_rules),
            patch("app.services.rule_scheduler.run_event_volume_anomaly_detection", mock_run_anomaly),
            patch("app.services.rule_scheduler.run_realtime_heuristics", mock_run_heuristics),
            patch("app.services.rule_scheduler.get_session_factory", return_value=mock_factory),
        ):
            svc = RuleSchedulerService(interval_seconds=0.05)
            await svc.start()
            await asyncio.sleep(0.12)
            await svc.stop()

        assert mock_run_anomaly.call_count >= 1

    async def test_error_in_run_rule_engine_does_not_crash_loop(self):
        """A single exception from run_rule_engine must not stop the scheduler."""
        from app.services.rule_scheduler import RuleSchedulerService

        call_count = 0

        async def flaky_run(session):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("transient DB error")
            return []

        mock_run_anomaly = AsyncMock(return_value=MagicMock(incident_created=False))
        mock_run_heuristics = AsyncMock(return_value=MagicMock(incidents_created=0))
        mock_session = _make_mock_session()
        mock_factory = MagicMock(return_value=mock_session)

        async def _wait_for_recovery() -> None:
            while call_count < 2:
                await asyncio.sleep(0.01)

        with (
            patch("app.services.rule_scheduler.run_rule_engine", side_effect=flaky_run),
            patch("app.services.rule_scheduler.run_event_volume_anomaly_detection", mock_run_anomaly),
            patch("app.services.rule_scheduler.run_realtime_heuristics", mock_run_heuristics),
            patch("app.services.rule_scheduler.get_session_factory", return_value=mock_factory),
        ):
            svc = RuleSchedulerService(interval_seconds=0.05)
            await svc.start()
            await asyncio.wait_for(_wait_for_recovery(), timeout=0.5)
            await svc.stop()

        # should have been called more than once: first call raised, loop continued
        assert call_count >= 2

    async def test_tick_count_increments(self):
        """tick_count should grow with each polling cycle."""
        from app.services.rule_scheduler import RuleSchedulerService

        mock_run = AsyncMock(return_value=[])
        mock_run_anomaly = AsyncMock(return_value=MagicMock(incident_created=False))
        mock_run_heuristics = AsyncMock(return_value=MagicMock(incidents_created=0))
        mock_session = _make_mock_session()
        mock_factory = MagicMock(return_value=mock_session)

        with (
            patch("app.services.rule_scheduler.run_rule_engine", mock_run),
            patch("app.services.rule_scheduler.run_event_volume_anomaly_detection", mock_run_anomaly),
            patch("app.services.rule_scheduler.run_realtime_heuristics", mock_run_heuristics),
            patch("app.services.rule_scheduler.get_session_factory", return_value=mock_factory),
        ):
            svc = RuleSchedulerService(interval_seconds=0.05)
            await svc.start()
            await asyncio.sleep(0.22)
            await svc.stop()

        assert svc.tick_count >= 2

    async def test_pending_auto_triage_incidents_are_enqueued_after_commit(self):
        """Incidents marked during the tick should be enqueued for AI triage after commit."""
        from app.services.rule_scheduler import RuleSchedulerService

        mock_run = AsyncMock(return_value=[])
        mock_run_anomaly = AsyncMock(return_value=MagicMock(incident_created=False))
        mock_run_heuristics = AsyncMock(return_value=MagicMock(incidents_created=0))
        mock_enqueue = MagicMock()
        mock_session = _make_mock_session()
        mock_factory = MagicMock(return_value=mock_session)

        with (
            patch("app.services.rule_scheduler.run_rule_engine", mock_run),
            patch("app.services.rule_scheduler.run_event_volume_anomaly_detection", mock_run_anomaly),
            patch("app.services.rule_scheduler.run_realtime_heuristics", mock_run_heuristics),
            patch("app.services.rule_scheduler.consume_incidents_marked_for_auto_triage", return_value=["inc-1", "inc-2"]),
            patch("app.services.rule_scheduler.enqueue_auto_triage_for_incident", mock_enqueue),
            patch("app.services.rule_scheduler.get_session_factory", return_value=mock_factory),
        ):
            svc = RuleSchedulerService(interval_seconds=0.05)
            await svc._tick()

        assert mock_enqueue.call_count == 2
        mock_enqueue.assert_any_call("inc-1")
        mock_enqueue.assert_any_call("inc-2")

    async def test_pending_notifications_are_enqueued_after_commit(self):
        """Incidents marked during the tick should be enqueued for notification after commit."""
        from app.services.rule_scheduler import RuleSchedulerService

        mock_run = AsyncMock(return_value=[])
        mock_run_anomaly = AsyncMock(return_value=MagicMock(incident_created=False))
        mock_run_heuristics = AsyncMock(return_value=MagicMock(incidents_created=0))
        mock_enqueue = MagicMock()
        mock_session = _make_mock_session()
        mock_factory = MagicMock(return_value=mock_session)

        with (
            patch("app.services.rule_scheduler.run_rule_engine", mock_run),
            patch("app.services.rule_scheduler.run_event_volume_anomaly_detection", mock_run_anomaly),
            patch("app.services.rule_scheduler.run_realtime_heuristics", mock_run_heuristics),
            patch("app.services.rule_scheduler.consume_incidents_marked_for_auto_triage", return_value=[]),
            patch("app.services.rule_scheduler.consume_incidents_marked_for_notification", return_value=["inc-9"]),
            patch("app.services.rule_scheduler.enqueue_incident_notification", mock_enqueue),
            patch("app.services.rule_scheduler.get_session_factory", return_value=mock_factory),
        ):
            svc = RuleSchedulerService(interval_seconds=0.05)
            await svc._tick()

        mock_enqueue.assert_called_once_with("inc-9")
