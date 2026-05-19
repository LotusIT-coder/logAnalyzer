"""Realtime heuristics engine for high-signal incident pre-filtering.

This module keeps the hot path lightweight: it evaluates recent events with
cheap counters and simple normalization before expensive AI analysis is queued.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from statistics import mean
from typing import Sequence

from sqlalchemy import select

from app.domain.models import Event, Incident
from app.services.ai_auto_triage import mark_incident_for_auto_triage
from app.services.notifications import mark_incident_for_notification

_MAX_HEURISTICS_EVENTS = 50_000
_MIN_PATTERN_LEN = 12

_NUMBER_RE = re.compile(r"\b\d+\b")
_HEX_RE = re.compile(r"\b[0-9a-f]{8,}\b", re.IGNORECASE)
_UUID_RE = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.IGNORECASE)
_WS_RE = re.compile(r"\s+")


@dataclass(slots=True)
class PatternSignal:
    pattern: str
    current_count: int
    baseline_avg_per_window: float
    ratio: float | None


@dataclass(slots=True)
class HeuristicsRunResult:
    incidents_created: int
    burst_signals: list[PatternSignal]
    novelty_signals: list[PatternSignal]
    patterns_evaluated: int
    burst_suppressed_cooldown: int
    novelty_suppressed_cooldown: int


def _normalize_pattern(message: str) -> str:
    text = (message or "").strip().lower()
    if not text:
        return ""
    text = _UUID_RE.sub("<uuid>", text)
    text = _HEX_RE.sub("<hex>", text)
    text = _NUMBER_RE.sub("<n>", text)
    text = _WS_RE.sub(" ", text)
    return text[:300]


def _pattern_hash(kind: str, pattern: str) -> str:
    raw = f"{kind}|{pattern}"
    return hashlib.sha1(raw.encode("utf-8"), usedforsecurity=False).hexdigest()[:16]


def _as_utc(ts: datetime) -> datetime:
    if ts.tzinfo is None:
        return ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc)


def detect_error_burst(
    *,
    current_count: int,
    baseline_counts: Sequence[int],
    min_current_count: int = 8,
    ratio_threshold: float = 3.0,
) -> PatternSignal | None:
    if current_count < min_current_count:
        return None

    baseline_avg = float(mean(baseline_counts)) if baseline_counts else 0.0
    if baseline_avg <= 0:
        return PatternSignal(
            pattern="",
            current_count=current_count,
            baseline_avg_per_window=0.0,
            ratio=None,
        )

    ratio = current_count / baseline_avg
    if ratio < ratio_threshold:
        return None

    return PatternSignal(
        pattern="",
        current_count=current_count,
        baseline_avg_per_window=baseline_avg,
        ratio=ratio,
    )


async def _open_heuristic_incident_exists(session, phash: str) -> bool:
    stmt = select(Incident).where(Incident.status.in_(["open", "investigating"]))
    result = await session.execute(stmt)
    tag = f"heuristic_hash:{phash}"
    return any(tag in (inc.tags_json or []) for inc in result.scalars().all())


async def _heuristic_cooldown_active(
    session,
    *,
    phash: str,
    now: datetime,
    cooldown_minutes: int,
) -> bool:
    if cooldown_minutes <= 0:
        return False
    cutoff = now - timedelta(minutes=cooldown_minutes)
    stmt = select(Incident).where(Incident.created_at >= cutoff)
    result = await session.execute(stmt)
    tag = f"heuristic_hash:{phash}"
    return any(tag in (inc.tags_json or []) for inc in result.scalars().all())


async def run_realtime_heuristics(
    session,
    *,
    reference_time: datetime | None = None,
    current_window_minutes: int = 2,
    baseline_window_minutes: int = 10,
    baseline_windows: int = 6,
    min_burst_count: int = 8,
    burst_ratio_threshold: float = 3.0,
    min_novelty_count: int = 5,
    cooldown_minutes: int = 15,
) -> HeuristicsRunResult:
    now = reference_time or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)

    current_start = now - timedelta(minutes=current_window_minutes)
    baseline_start = current_start - timedelta(minutes=baseline_window_minutes * baseline_windows)

    result = await session.execute(
        select(Event)
        .where(Event.created_at >= baseline_start, Event.created_at <= now)
        .where(Event.severity.in_(["warning", "warn", "error", "err", "critical", "crit"]))
        .limit(_MAX_HEURISTICS_EVENTS)
    )
    events = list(result.scalars().all())

    current_counts: dict[str, int] = {}
    baseline_counts: dict[str, int] = {}

    for event in events:
        pattern = _normalize_pattern(event.message or "")
        if len(pattern) < _MIN_PATTERN_LEN:
            continue
        created_at = _as_utc(event.created_at or event.timestamp)
        if created_at >= current_start:
            current_counts[pattern] = current_counts.get(pattern, 0) + 1
        else:
            baseline_counts[pattern] = baseline_counts.get(pattern, 0) + 1

    incidents_created = 0
    burst_signals: list[PatternSignal] = []
    novelty_signals: list[PatternSignal] = []
    burst_suppressed_cooldown = 0
    novelty_suppressed_cooldown = 0

    for pattern, current_count in sorted(current_counts.items(), key=lambda x: x[1], reverse=True):
        baseline_total = baseline_counts.get(pattern, 0)
        baseline_avg = baseline_total / max(1, baseline_windows)

        if baseline_total <= 0 and current_count >= min_novelty_count:
            novelty_signal = PatternSignal(
                pattern=pattern,
                current_count=current_count,
                baseline_avg_per_window=0.0,
                ratio=None,
            )
            novelty_signals.append(novelty_signal)

            phash = _pattern_hash("novelty", pattern)
            if await _heuristic_cooldown_active(
                session,
                phash=phash,
                now=now,
                cooldown_minutes=cooldown_minutes,
            ):
                novelty_suppressed_cooldown += 1
                continue
            if await _open_heuristic_incident_exists(session, phash):
                continue
            incident = Incident(
                title="Heuristic alert: Novel error pattern detected",
                status="open",
                severity="warning",
                first_seen=current_start,
                last_seen=now,
                event_count=current_count,
                summary=(
                    "A previously unseen warning/error pattern appeared repeatedly "
                    f"in the current window (count={current_count}). "
                    f"Pattern sample: {pattern[:180]}"
                ),
                tags_json=["heuristic", "novelty", f"heuristic_hash:{phash}"],
            )
            session.add(incident)
            await session.flush()
            mark_incident_for_auto_triage(session, incident.id)
            mark_incident_for_notification(session, incident.id)
            incidents_created += 1
            continue

        burst_signal = detect_error_burst(
            current_count=current_count,
            baseline_counts=[baseline_avg],
            min_current_count=min_burst_count,
            ratio_threshold=burst_ratio_threshold,
        )
        if burst_signal is None:
            continue

        burst_signal.pattern = pattern
        burst_signal.baseline_avg_per_window = baseline_avg
        burst_signals.append(burst_signal)

        phash = _pattern_hash("burst", pattern)
        if await _heuristic_cooldown_active(
            session,
            phash=phash,
            now=now,
            cooldown_minutes=cooldown_minutes,
        ):
            burst_suppressed_cooldown += 1
            continue
        if await _open_heuristic_incident_exists(session, phash):
            continue

        incident = Incident(
            title="Heuristic alert: Error burst detected",
            status="open",
            severity="error",
            first_seen=current_start,
            last_seen=now,
            event_count=current_count,
            summary=(
                "A warning/error pattern spiked above baseline. "
                f"Current={current_count}, baseline_avg={baseline_avg:.2f}, "
                f"ratio={burst_signal.ratio:.2f}. Pattern sample: {pattern[:180]}"
            ),
            tags_json=["heuristic", "burst", f"heuristic_hash:{phash}"],
        )
        session.add(incident)
        await session.flush()
        mark_incident_for_auto_triage(session, incident.id)
        mark_incident_for_notification(session, incident.id)
        incidents_created += 1

    return HeuristicsRunResult(
        incidents_created=incidents_created,
        burst_signals=burst_signals,
        novelty_signals=novelty_signals,
        patterns_evaluated=len(current_counts),
        burst_suppressed_cooldown=burst_suppressed_cooldown,
        novelty_suppressed_cooldown=novelty_suppressed_cooldown,
    )
