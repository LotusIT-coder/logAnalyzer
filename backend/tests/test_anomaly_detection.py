"""Unit tests for statistical anomaly detection (Point 6)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.domain.models import Event, Incident, Source


class TestDetectVolumeSpike:
    def test_returns_not_anomalous_without_enough_baseline_points(self):
        from app.services.anomaly_detection import detect_volume_spike

        result = detect_volume_spike([5, 6])

        assert result.is_anomaly is False
        assert result.reason == "insufficient_baseline"

    def test_detects_spike_when_latest_bucket_far_exceeds_baseline(self):
        from app.services.anomaly_detection import detect_volume_spike

        result = detect_volume_spike([4, 5, 6, 5, 22])

        assert result.is_anomaly is True
        assert result.current_count == 22
        assert result.baseline_mean > 0
        assert result.spike_ratio > 2.0

    def test_does_not_flag_normal_variation(self):
        from app.services.anomaly_detection import detect_volume_spike

        result = detect_volume_spike([10, 11, 12, 11, 12])

        assert result.is_anomaly is False

    def test_zero_baseline_uses_ratio_fallback(self):
        from app.services.anomaly_detection import detect_volume_spike

        result = detect_volume_spike([0, 0, 0, 0, 3])

        assert result.is_anomaly is True
        assert result.baseline_mean == 0.0
        assert result.spike_ratio is None


def _make_source() -> Source:
    return Source(
        name="anomaly-src",
        type="file",
        enabled=True,
        config_json={"path": "/var/log/anomaly.log"},
    )


def _make_event(source_id: str, ts: datetime, index: int) -> Event:
    return Event(
        source_id=source_id,
        timestamp=ts,
        severity="info",
        message=f"event-{index}",
        service="app",
        host="host-1",
        environment="test",
        event_type="log",
        fields_json={},
        fingerprint=f"fp-{ts.isoformat()}-{index}",
    )


@pytest.mark.asyncio
class TestRunEventVolumeAnomalyDetection:
    async def test_creates_incident_for_volume_spike(self, db_session):
        from app.services.anomaly_detection import run_event_volume_anomaly_detection

        reference_time = datetime(2026, 5, 6, 10, 5, tzinfo=timezone.utc)
        source = _make_source()
        db_session.add(source)
        await db_session.flush()

        # Baseline buckets: 1,1,1,1 then current bucket: 8
        for minute_offset in range(4):
            ts = reference_time - timedelta(minutes=4 - minute_offset)
            db_session.add(_make_event(source.id, ts, minute_offset))

        for index in range(8):
            db_session.add(_make_event(source.id, reference_time, 100 + index))

        await db_session.flush()

        result = await run_event_volume_anomaly_detection(
            db_session,
            reference_time=reference_time,
            bucket_minutes=1,
            bucket_count=5,
        )

        assert result.is_anomaly is True
        assert result.incident_created is True
        assert result.incident is not None
        assert result.incident.title == "Anomaly detected: Event volume spike"
        assert result.incident.rule_id is None
        assert result.incident.event_count == 8

    async def test_does_not_create_incident_for_normal_variation(self, db_session):
        from app.services.anomaly_detection import run_event_volume_anomaly_detection

        reference_time = datetime(2026, 5, 6, 10, 5, tzinfo=timezone.utc)
        source = _make_source()
        db_session.add(source)
        await db_session.flush()

        counts = [10, 11, 12, 11, 12]
        for bucket_index, count in enumerate(counts):
            ts = reference_time - timedelta(minutes=4 - bucket_index)
            for item_index in range(count):
                db_session.add(_make_event(source.id, ts, bucket_index * 100 + item_index))

        await db_session.flush()

        result = await run_event_volume_anomaly_detection(
            db_session,
            reference_time=reference_time,
            bucket_minutes=1,
            bucket_count=5,
        )

        assert result.is_anomaly is False
        assert result.incident_created is False
        assert result.incident is None

    async def test_open_anomaly_incident_is_not_duplicated(self, db_session):
        from app.services.anomaly_detection import run_event_volume_anomaly_detection

        reference_time = datetime(2026, 5, 6, 10, 5, tzinfo=timezone.utc)
        source = _make_source()
        db_session.add(source)
        await db_session.flush()

        for minute_offset in range(4):
            ts = reference_time - timedelta(minutes=4 - minute_offset)
            db_session.add(_make_event(source.id, ts, minute_offset))

        for index in range(8):
            db_session.add(_make_event(source.id, reference_time, 100 + index))

        db_session.add(
            Incident(
                title="Anomaly detected: Event volume spike",
                status="open",
                severity="warning",
                first_seen=reference_time - timedelta(minutes=1),
                last_seen=reference_time,
                event_count=8,
                tags_json=["anomaly", "event-volume"],
            )
        )
        await db_session.flush()

        result = await run_event_volume_anomaly_detection(
            db_session,
            reference_time=reference_time,
            bucket_minutes=1,
            bucket_count=5,
        )

        assert result.is_anomaly is True
        assert result.incident_created is False
        assert result.incident is None