"""Rule Scheduler — periodically runs the rule engine against all enabled rules.

Design mirrors WatcherService for consistency:
- Single asyncio task, configurable interval
- Per-tick error isolation
- Exposes tick_count for testability
- Integrated into FastAPI lifespan via app/main.py
"""
from __future__ import annotations

import asyncio

import structlog

from app.db.session import get_session_factory
from app.services.anomaly_detection import run_event_volume_anomaly_detection
from app.services.ai_auto_triage import (
    consume_incidents_marked_for_auto_triage,
    enqueue_auto_triage_for_incident,
)
from app.services.notifications import (
    consume_incidents_marked_for_notification,
    enqueue_incident_notification,
)
from app.services.rule_engine import run_rule_engine

logger = structlog.get_logger(__name__)


class RuleSchedulerService:
    """Background service that evaluates all enabled rules on a fixed interval."""

    def __init__(self, interval_seconds: float = 30.0) -> None:
        self.interval_seconds = interval_seconds
        self._task: asyncio.Task | None = None
        self.tick_count: int = 0

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(self) -> None:
        """Start the rule evaluation loop (idempotent)."""
        if self.running:
            return
        self._task = asyncio.create_task(self._loop(), name="rule-scheduler")
        logger.info("rule_scheduler_started", interval_seconds=self.interval_seconds)

    async def stop(self) -> None:
        """Cancel the evaluation loop and wait for it to finish."""
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        logger.info("rule_scheduler_stopped")

    async def _loop(self) -> None:
        while True:
            await self._tick()
            self.tick_count += 1
            await asyncio.sleep(self.interval_seconds)

    async def _tick(self) -> None:
        factory = get_session_factory()
        async with factory() as session:
            try:
                results = await run_rule_engine(session)
                anomaly_result = await run_event_volume_anomaly_detection(session)
                incidents_created = sum(1 for r in results if r.get("incident_created"))
                if anomaly_result.incident_created:
                    incidents_created += 1
                if incidents_created:
                    logger.info("rule_scheduler_incidents_created", count=incidents_created)
                await session.commit()
                for incident_id in consume_incidents_marked_for_auto_triage(session):
                    enqueue_auto_triage_for_incident(incident_id)
                for incident_id in consume_incidents_marked_for_notification(session):
                    enqueue_incident_notification(incident_id)
            except Exception:
                logger.exception("rule_scheduler_tick_error")
                await session.rollback()
