"""Rule engine: evaluate rules against recent events to detect incidents."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import List, Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.models import Event, Incident, Rule
from app.services.ai_auto_triage import mark_incident_for_auto_triage
from app.services.notifications import mark_incident_for_notification


def _matches_condition(event: "Event", condition: dict) -> bool:
    """
    Minimal condition evaluator. Condition is a dict like:
      {"severity": "error"}
      {"field": "service", "value": "nginx"}
      {"message_contains": "OOM"}
      {"severity_in": ["error", "critical"]}
    Returns True if the event satisfies the condition.
    """
    if not condition:
        return True

    if "severity" in condition:
        if event.severity != condition["severity"]:
            return False

    if "severity_in" in condition:
        if event.severity not in condition["severity_in"]:
            return False

    if "message_contains" in condition:
        needle = condition["message_contains"]
        if needle.lower() not in (event.message or "").lower():
            return False

    if "service" in condition:
        if event.service != condition["service"]:
            return False

    if "host" in condition:
        if event.host != condition["host"]:
            return False

    if "environment" in condition:
        if event.environment != condition["environment"]:
            return False

    if "event_type" in condition:
        if event.event_type != condition["event_type"]:
            return False

    if "field" in condition:
        field_name = condition["field"]
        field_value = (event.fields_json or {}).get(field_name)

        if "value" in condition and field_value != condition["value"]:
            return False

        if "value_in" in condition and field_value not in condition["value_in"]:
            return False

    return True


async def evaluate_rule(
    session: AsyncSession,
    rule: Rule,
    reference_time: Optional[datetime] = None,
) -> tuple[int, bool]:
    """
    Count events matching *rule* within its time window.
    Returns (matched_event_count, would_fire).
    """
    now = reference_time or datetime.now(timezone.utc)
    window_start = now - timedelta(seconds=rule.window_seconds)

    stmt = select(Event).where(Event.timestamp >= window_start, Event.timestamp <= now)
    result = await session.execute(stmt)
    events = result.scalars().all()

    matched = [e for e in events if _matches_condition(e, rule.condition_json)]
    would_fire = len(matched) >= rule.threshold
    return len(matched), would_fire


async def fire_incident_if_needed(
    session: AsyncSession,
    rule: Rule,
    matched_events: List["Event"],
    now: datetime,
) -> Optional[Incident]:
    """Create an Incident if the rule threshold is reached and no open incident exists."""
    # Check for existing open/investigating incident for this rule
    existing = await session.execute(
        select(Incident).where(
            Incident.rule_id == rule.id,
            Incident.status.in_(["open", "investigating"]),
        )
    )
    if existing.scalar_one_or_none() is not None:
        return None  # already an active incident for this rule

    first_seen = min(e.timestamp for e in matched_events)
    last_seen = max(e.timestamp for e in matched_events)

    incident = Incident(
        title=f"Rule fired: {rule.name}",
        status="open",
        severity=rule.severity,
        first_seen=first_seen,
        last_seen=last_seen,
        event_count=len(matched_events),
        rule_id=rule.id,
        tags_json=[],
    )
    session.add(incident)
    await session.flush()
    mark_incident_for_auto_triage(session, incident.id)
    mark_incident_for_notification(session, incident.id)
    return incident


async def run_rule_engine(session: AsyncSession) -> list[dict]:
    """Evaluate all enabled rules and create incidents where threshold is reached."""
    from sqlalchemy import select as sa_select

    rules_result = await session.execute(
        sa_select(Rule).where(Rule.enabled == True)  # noqa: E712
    )
    rules: List[Rule] = list(rules_result.scalars().all())
    results = []
    now = datetime.now(timezone.utc)

    for rule in rules:
        window_start = now - timedelta(seconds=rule.window_seconds)
        stmt = select(Event).where(Event.timestamp >= window_start, Event.timestamp <= now)
        result = await session.execute(stmt)
        events = list(result.scalars().all())

        matched = [e for e in events if _matches_condition(e, rule.condition_json)]
        fired = len(matched) >= rule.threshold
        incident = None

        if fired:
            incident = await fire_incident_if_needed(session, rule, matched, now)

        results.append({
            "rule_id": rule.id,
            "rule_name": rule.name,
            "matched": len(matched),
            "threshold": rule.threshold,
            "fired": fired,
            "incident_created": incident is not None,
        })

    return results
