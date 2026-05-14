"""SOC Analyst Service – continuous AI-driven threat monitoring.

The SOCAnalystService runs as an asyncio background task alongside the
WatcherService. Every ``interval_seconds`` it fetches the N most-recent
events (configurable severity filter), bundles them into a structured
prompt, and asks Ollama to analyse them for suspicious patterns.

If Ollama returns a finding with confidence >= the configured threshold
AND no open AI-SOC incident for the same pattern hash already exists,
a new Incident is created and tagged with ``ai_soc``.

Design principles
-----------------
- Completely independent of WatcherService; runs on its own asyncio task.
- Per-tick error isolation: any exception is logged, the loop continues.
- Deduplication via ``pattern_hash`` stored in ``tags_json`` to prevent
  alert storms when the same pattern is detected on consecutive ticks.
- The service is disabled by default (``soc_analyst_enabled = false``).
  Enable it in ``.env`` or via environment variable.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
from datetime import datetime, timezone
from typing import Any

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import ollama_client
from app.config import get_settings
from app.db.session import get_session_factory
from app.domain.models import Event, Incident
from app.services.ai_auto_triage import mark_incident_for_auto_triage
from app.services.notifications import mark_incident_for_notification

logger = structlog.get_logger(__name__)

# Severities considered worth analysing.  Lower severities are usually
# too noisy for the AI and would bloat the prompt.
_RELEVANT_SEVERITIES = {"warning", "error", "critical", "warn", "err", "crit"}

_SYSTEM_PROMPT = (
    "You are an expert SOC (Security Operations Center) analyst. "
    "You will receive a batch of recent log events in JSON format. "
    "Your task:\n"
    "1. Identify patterns that indicate a security threat, attack, or serious "
    "operational anomaly (e.g. brute-force, lateral movement, privilege escalation, "
    "DoS, data exfiltration, persistent malware, repeated crashes).\n"
    "2. Respond ONLY with valid JSON matching this exact schema – no prose outside "
    "the JSON object:\n"
    '{"threat_detected": true|false, "pattern_type": "<short id>", '
    '"severity": "low"|"medium"|"high"|"critical", "confidence": <0.0-1.0>, '
    '"title": "<max 120 chars>", '
    '"summary": "<2-4 sentences: what you observed, why suspicious, recommended action>"}\n'
    "If no threat is detected, set threat_detected to false and keep the other "
    "fields empty strings / 0.0."
)


def _build_prompt(events: list[dict[str, Any]]) -> str:
    lines = ["Analyse the following log events for security threats:\n"]
    lines.append(json.dumps(events, default=str, ensure_ascii=False, indent=None))
    return "\n".join(lines)


def _pattern_hash(pattern_type: str, title: str) -> str:
    """Short deterministic hash used for deduplication."""
    raw = f"{pattern_type}|{title}"
    return hashlib.sha1(raw.encode(), usedforsecurity=False).hexdigest()[:16]


def _map_severity(ai_severity: str) -> str:
    """Map AI severity strings to the DB-allowed set."""
    mapping = {
        "critical": "critical",
        "high": "error",
        "medium": "warning",
        "low": "info",
    }
    return mapping.get(ai_severity.lower(), "warning")


async def _events_to_dicts(events: list[Event]) -> list[dict[str, Any]]:
    return [
        {
            "id": e.id,
            "timestamp": e.timestamp.isoformat() if e.timestamp else None,
            "severity": e.severity,
            "service": e.service,
            "host": e.host,
            "message": e.message,
            "event_type": e.event_type,
        }
        for e in events
    ]


async def _fetch_recent_events(
    session: AsyncSession,
    limit: int,
    source_ids: list[str] | None = None,
) -> list[Event]:
    """Load the most-recent events with relevant severities."""
    stmt = (
        select(Event)
        .where(Event.severity.in_(_RELEVANT_SEVERITIES))
        .order_by(Event.timestamp.desc())
        .limit(limit)
    )
    if source_ids:
        stmt = stmt.where(Event.source_id.in_(source_ids))
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def _open_soc_incident_exists(
    session: AsyncSession,
    phash: str,
) -> bool:
    """Return True if an open/investigating AI-SOC incident for this hash exists.

    The check is done in Python rather than SQL to stay compatible with both
    PostgreSQL (JSONB) and SQLite (JSON, used in tests).
    """
    stmt = select(Incident).where(
        Incident.status.in_(["open", "investigating"]),
    )
    result = await session.execute(stmt)
    tag = f"ai_soc_hash:{phash}"
    return any(tag in (inc.tags_json or []) for inc in result.scalars().all())


async def _run_analysis_tick(
    model: str,
    window_events: int,
    confidence_threshold: float,
    source_ids: list[str] | None = None,
) -> None:
    """Single analysis cycle: fetch events → ask Ollama → optionally create incident."""
    factory = get_session_factory()
    async with factory() as session:
        events = await _fetch_recent_events(session, window_events, source_ids)
        if not events:
            logger.debug("soc_analyst_no_events")
            return

        event_dicts = await _events_to_dicts(events)
        prompt = _build_prompt(event_dicts)

        t0 = time.monotonic()
        try:
            raw = await ollama_client.generate(
                model=model,
                prompt=prompt,
                system=_SYSTEM_PROMPT,
                temperature=0.1,
                max_tokens=512,
            )
        except Exception:
            logger.exception("soc_analyst_ollama_error", model=model)
            return
        latency_ms = int((time.monotonic() - t0) * 1000)

        # Parse JSON response
        try:
            # Strip markdown fences if present
            cleaned = raw.strip()
            if cleaned.startswith("```"):
                cleaned = cleaned.split("```")[1]
                if cleaned.startswith("json"):
                    cleaned = cleaned[4:]
            finding: dict[str, Any] = json.loads(cleaned)
        except (json.JSONDecodeError, IndexError):
            logger.warning(
                "soc_analyst_invalid_json",
                latency_ms=latency_ms,
                raw_preview=raw[:200],
            )
            return

        threat_detected: bool = bool(finding.get("threat_detected", False))
        confidence: float = float(finding.get("confidence", 0.0))
        pattern_type: str = str(finding.get("pattern_type", "unknown"))
        severity_ai: str = str(finding.get("severity", "medium"))
        title: str = str(finding.get("title", "AI SOC: Potential threat detected"))
        summary: str = str(finding.get("summary", ""))

        logger.info(
            "soc_analyst_tick_result",
            threat_detected=threat_detected,
            confidence=confidence,
            pattern_type=pattern_type,
            latency_ms=latency_ms,
        )

        if not threat_detected or confidence < confidence_threshold:
            return

        phash = _pattern_hash(pattern_type, title)

        if await _open_soc_incident_exists(session, phash):
            logger.debug(
                "soc_analyst_dedup_skip",
                pattern_hash=phash,
                pattern_type=pattern_type,
            )
            return

        now = datetime.now(timezone.utc)
        incident = Incident(
            title=title[:200],
            status="open",
            severity=_map_severity(severity_ai),
            first_seen=now,
            last_seen=now,
            event_count=len(events),
            rule_id=None,
            summary=summary,
            tags_json=["ai_soc", f"ai_soc_hash:{phash}", f"pattern:{pattern_type}"],
        )
        session.add(incident)
        await session.flush()

        mark_incident_for_auto_triage(session, incident.id)
        mark_incident_for_notification(session, incident.id)

        await session.commit()

        logger.warning(
            "soc_analyst_incident_created",
            incident_id=incident.id,
            title=title,
            severity=incident.severity,
            confidence=confidence,
            pattern_type=pattern_type,
        )


class SOCAnalystService:
    """Async background service that periodically asks Ollama for threat analysis."""

    def __init__(
        self,
        model: str,
        interval_seconds: float,
        confidence_threshold: float,
        window_events: int,
        source_ids: list[str] | None = None,
    ) -> None:
        self.model = model
        self.interval_seconds = interval_seconds
        self.confidence_threshold = confidence_threshold
        self.window_events = window_events
        self.source_ids = list(dict.fromkeys(source_ids or []))
        self._task: asyncio.Task | None = None
        self.tick_count: int = 0

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(self) -> None:
        if self.running:
            return
        self._task = asyncio.create_task(self._loop(), name="soc-analyst")
        logger.info(
            "soc_analyst_started",
            model=self.model,
            interval_seconds=self.interval_seconds,
            confidence_threshold=self.confidence_threshold,
            window_events=self.window_events,
            source_ids=self.source_ids,
        )

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        logger.info("soc_analyst_stopped")

    async def _loop(self) -> None:
        while True:
            try:
                await _run_analysis_tick(
                    model=self.model,
                    window_events=self.window_events,
                    confidence_threshold=self.confidence_threshold,
                    source_ids=self.source_ids,
                )
            except Exception:
                logger.exception("soc_analyst_loop_error")
            self.tick_count += 1
            await asyncio.sleep(self.interval_seconds)
