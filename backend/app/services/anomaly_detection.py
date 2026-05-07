"""Statistical anomaly detection helpers."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from statistics import mean, pstdev
from typing import Sequence

from sqlalchemy import select

from app.domain.models import Event, Incident
from app.services.ai_auto_triage import mark_incident_for_auto_triage
from app.services.notifications import mark_incident_for_notification


@dataclass(slots=True)
class VolumeSpikeResult:
    is_anomaly: bool
    reason: str
    current_count: int
    baseline_mean: float
    baseline_stddev: float
    z_score: float | None
    spike_ratio: float | None


@dataclass(slots=True)
class EventVolumeAnomalyRunResult:
    is_anomaly: bool
    reason: str
    bucket_counts: list[int]
    incident_created: bool
    incident: Incident | None
    detection: VolumeSpikeResult


ANOMALY_VOLUME_INCIDENT_TITLE = "Anomaly detected: Event volume spike"


def detect_volume_spike(
    counts: Sequence[int],
    *,
    min_baseline_points: int = 3,
    z_threshold: float = 2.5,
    spike_ratio_threshold: float = 2.0,
    zero_baseline_min_count: int = 1,
) -> VolumeSpikeResult:
    """Compare the latest bucket against the historical baseline.

    The last value in ``counts`` is treated as the current bucket.
    All preceding values form the baseline window.
    """
    if len(counts) <= min_baseline_points:
        current = counts[-1] if counts else 0
        return VolumeSpikeResult(
            is_anomaly=False,
            reason="insufficient_baseline",
            current_count=current,
            baseline_mean=0.0,
            baseline_stddev=0.0,
            z_score=None,
            spike_ratio=None,
        )

    baseline = [int(value) for value in counts[:-1]]
    current_count = int(counts[-1])
    baseline_mean = float(mean(baseline)) if baseline else 0.0
    baseline_stddev = float(pstdev(baseline)) if len(baseline) > 1 else 0.0
    z_score = None
    if baseline_stddev > 0:
        z_score = (current_count - baseline_mean) / baseline_stddev

    spike_ratio = None if baseline_mean <= 0 else current_count / baseline_mean

    is_anomaly = False
    reason = "within_expected_range"

    if baseline_mean <= 0:
        is_anomaly = current_count >= zero_baseline_min_count
        reason = "zero_baseline_spike" if is_anomaly else "zero_baseline_no_spike"
    elif current_count > baseline_mean:
        if z_score is not None and z_score >= z_threshold:
            is_anomaly = True
            reason = "zscore_spike"
        elif spike_ratio is not None and spike_ratio >= spike_ratio_threshold:
            is_anomaly = True
            reason = "ratio_spike"

    return VolumeSpikeResult(
        is_anomaly=is_anomaly,
        reason=reason,
        current_count=current_count,
        baseline_mean=baseline_mean,
        baseline_stddev=baseline_stddev,
        z_score=z_score,
        spike_ratio=spike_ratio,
    )


def _floor_to_bucket(ts: datetime, bucket_minutes: int) -> datetime:
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    floored_minute = (ts.minute // bucket_minutes) * bucket_minutes
    return ts.replace(minute=floored_minute, second=0, microsecond=0)


async def run_event_volume_anomaly_detection(
    session,
    *,
    reference_time: datetime | None = None,
    bucket_minutes: int = 1,
    bucket_count: int = 5,
) -> EventVolumeAnomalyRunResult:
    """Evaluate recent event-volume buckets and create an anomaly incident if needed."""
    now = reference_time or datetime.now(timezone.utc)
    current_bucket_start = _floor_to_bucket(now, bucket_minutes)
    bucket_delta = timedelta(minutes=bucket_minutes)
    bucket_starts = [
        current_bucket_start - bucket_delta * offset
        for offset in reversed(range(bucket_count))
    ]
    earliest_bucket_start = bucket_starts[0]

    result = await session.execute(
        select(Event).where(Event.timestamp >= earliest_bucket_start, Event.timestamp <= now)
    )
    events = list(result.scalars().all())

    counts_by_bucket = {bucket_start: 0 for bucket_start in bucket_starts}
    for event in events:
        bucket_start = _floor_to_bucket(event.timestamp, bucket_minutes)
        if bucket_start in counts_by_bucket:
            counts_by_bucket[bucket_start] += 1

    bucket_counts = [counts_by_bucket[bucket_start] for bucket_start in bucket_starts]
    detection = detect_volume_spike(bucket_counts)

    if not detection.is_anomaly:
        return EventVolumeAnomalyRunResult(
            is_anomaly=False,
            reason=detection.reason,
            bucket_counts=bucket_counts,
            incident_created=False,
            incident=None,
            detection=detection,
        )

    existing = await session.execute(
        select(Incident).where(
            Incident.title == ANOMALY_VOLUME_INCIDENT_TITLE,
            Incident.status.in_(["open", "investigating"]),
        )
    )
    if existing.scalar_one_or_none() is not None:
        return EventVolumeAnomalyRunResult(
            is_anomaly=True,
            reason=detection.reason,
            bucket_counts=bucket_counts,
            incident_created=False,
            incident=None,
            detection=detection,
        )

    incident = Incident(
        title=ANOMALY_VOLUME_INCIDENT_TITLE,
        status="open",
        severity="warning",
        first_seen=current_bucket_start,
        last_seen=now,
        event_count=detection.current_count,
        rule_id=None,
        summary=(
            f"Event volume spike detected: current bucket={detection.current_count}, "
            f"baseline_mean={detection.baseline_mean:.2f}, reason={detection.reason}"
        ),
        tags_json=["anomaly", "event-volume"],
    )
    session.add(incident)
    await session.flush()
    mark_incident_for_auto_triage(session, incident.id)
    mark_incident_for_notification(session, incident.id)

    return EventVolumeAnomalyRunResult(
        is_anomaly=True,
        reason=detection.reason,
        bucket_counts=bucket_counts,
        incident_created=True,
        incident=incident,
        detection=detection,
    )