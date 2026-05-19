"""Tests for realtime heuristics engine (burst + novelty)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.domain.models import Event, Incident, Source
from app.services.heuristics_engine import (
    _normalize_pattern,
    _pattern_hash,
    detect_error_burst,
    run_realtime_heuristics,
)


def _make_source() -> Source:
    return Source(
        name="heuristics-src",
        type="file",
        enabled=True,
        config_json={"path": "/var/log/heuristics.log"},
    )


def _make_event(source_id: str, created_at: datetime, message: str, severity: str = "error") -> Event:
    return Event(
        source_id=source_id,
        timestamp=created_at,
        created_at=created_at,
        severity=severity,
        message=message,
        service="app",
        host="host-1",
        environment="test",
        event_type="log",
        fields_json={},
    )


class TestDetectErrorBurst:
    def test_detects_burst_when_ratio_exceeds_threshold(self):
        signal = detect_error_burst(current_count=15, baseline_counts=[3, 3, 3], ratio_threshold=3.0)
        assert signal is not None
        assert signal.current_count == 15

    def test_returns_none_when_below_min_count(self):
        signal = detect_error_burst(current_count=2, baseline_counts=[0, 0, 0], min_current_count=5)
        assert signal is None


@pytest.mark.asyncio
class TestRunRealtimeHeuristics:
    async def test_creates_novelty_incident_for_new_pattern(self, db_session):
        now = datetime(2026, 5, 19, 12, 0, tzinfo=timezone.utc)
        source = _make_source()
        db_session.add(source)
        await db_session.flush()

        for i in range(6):
            db_session.add(
                _make_event(
                    source.id,
                    now - timedelta(minutes=1, seconds=i),
                    message=f"Unique failure marker token alpha id={1000 + i}",
                    severity="error",
                )
            )

        result = await run_realtime_heuristics(
            db_session,
            reference_time=now,
            current_window_minutes=2,
            baseline_window_minutes=10,
            baseline_windows=6,
            min_novelty_count=5,
        )

        assert result.incidents_created >= 1
        assert result.novelty_signals
        assert result.patterns_evaluated >= 1

        rows = await db_session.execute(select(Incident).where(Incident.title == "Heuristic alert: Novel error pattern detected"))
        assert rows.scalar_one_or_none() is not None

    async def test_creates_burst_incident_when_pattern_spikes(self, db_session):
        now = datetime(2026, 5, 19, 12, 0, tzinfo=timezone.utc)
        source = _make_source()
        db_session.add(source)
        await db_session.flush()

        # Baseline: sparse historical occurrences
        for i in range(6):
            db_session.add(
                _make_event(
                    source.id,
                    now - timedelta(minutes=25 + i),
                    message="Database timeout connecting to shard 12",
                    severity="error",
                )
            )

        # Current window: burst
        for i in range(12):
            db_session.add(
                _make_event(
                    source.id,
                    now - timedelta(seconds=i),
                    message="Database timeout connecting to shard 99",
                    severity="error",
                )
            )

        result = await run_realtime_heuristics(
            db_session,
            reference_time=now,
            current_window_minutes=2,
            baseline_window_minutes=5,
            baseline_windows=6,
            min_burst_count=8,
            burst_ratio_threshold=3.0,
        )

        assert result.incidents_created >= 1
        assert result.burst_signals
        assert result.patterns_evaluated >= 1

        rows = await db_session.execute(select(Incident).where(Incident.title == "Heuristic alert: Error burst detected"))
        assert rows.scalar_one_or_none() is not None

    async def test_cooldown_suppresses_duplicate_pattern_even_if_prior_incident_closed(self, db_session):
        now = datetime(2026, 5, 19, 12, 0, tzinfo=timezone.utc)
        source = _make_source()
        db_session.add(source)
        await db_session.flush()

        for i in range(8):
            db_session.add(
                _make_event(
                    source.id,
                    now - timedelta(seconds=i),
                    message="Auth backend timeout for user 1234",
                    severity="error",
                )
            )

        pattern = _normalize_pattern("Auth backend timeout for user 5678")
        phash = _pattern_hash("novelty", pattern)
        db_session.add(
            Incident(
                title="older heuristic",
                status="resolved",
                severity="warning",
                first_seen=now - timedelta(minutes=5),
                last_seen=now - timedelta(minutes=5),
                event_count=3,
                summary="already alerted",
                tags_json=["heuristic", "novelty", f"heuristic_hash:{phash}"],
                created_at=now - timedelta(minutes=5),
            )
        )
        await db_session.flush()

        result = await run_realtime_heuristics(
            db_session,
            reference_time=now,
            current_window_minutes=2,
            baseline_window_minutes=10,
            baseline_windows=6,
            min_novelty_count=5,
            cooldown_minutes=15,
        )

        assert result.incidents_created == 0
        assert result.novelty_suppressed_cooldown >= 1
