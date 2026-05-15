"""Rule engine: evaluate rules against recent events to detect incidents."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, List, Optional

import structlog
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.models import Event, Incident, Rule
from app.services.ai_auto_triage import mark_incident_for_auto_triage
from app.services.notifications import mark_incident_for_notification

logger = structlog.get_logger(__name__)

# Safety cap: never load more than this many Event ORM objects per rule evaluation.
# Only used when a rule has a JSONB "field" condition that cannot be pushed to SQL.
_RULE_EVENT_LIMIT = 10_000


def _event_group_value(event: Event, group_by_entity: str | None) -> str:
    if not group_by_entity:
        return "__all__"

    values: list[str] = []
    for raw_key in str(group_by_entity).split(","):
        key = raw_key.strip()
        if not key:
            continue
        if hasattr(event, key):
            value = getattr(event, key)
        else:
            value = (event.fields_json or {}).get(key)
        values.append(str(value) if value not in {None, ""} else "__missing__")

    return "|".join(values) if values else "__all__"


def _evaluate_sequence_matches(
    events: list[Event],
    sequence: list[dict[str, Any]],
    group_by_entity: str | None,
) -> tuple[int, datetime | None, datetime | None]:
    if not sequence:
        return 0, None, None

    grouped: dict[str, list[Event]] = {}
    for event in sorted(events, key=lambda item: item.timestamp):
        grouped.setdefault(_event_group_value(event, group_by_entity), []).append(event)

    matched_sequences: list[list[Event]] = []
    for grouped_events in grouped.values():
        step_index = 0
        current_sequence: list[Event] = []

        for event in grouped_events:
            current_condition = sequence[step_index]
            if _matches_condition(event, current_condition):
                current_sequence.append(event)
                step_index += 1
                if step_index == len(sequence):
                    matched_sequences.append(list(current_sequence))
                    current_sequence = []
                    step_index = 0
                continue

            if current_sequence and _matches_condition(event, sequence[0]):
                current_sequence = [event]
                step_index = 1

    if not matched_sequences:
        return 0, None, None

    first_seen = min(sequence_events[0].timestamp for sequence_events in matched_sequences)
    last_seen = max(sequence_events[-1].timestamp for sequence_events in matched_sequences)
    return len(matched_sequences), first_seen, last_seen


def _evaluate_geo_anomaly_matches(
    events: list[Event],
    condition: dict[str, Any],
) -> tuple[int, datetime | None, datetime | None]:
    entity_field = str(condition.get("entity_field") or "username")
    location_fields = condition.get("location_fields") or ["country", "asn"]
    if not isinstance(location_fields, list) or not location_fields:
        location_fields = ["country", "asn"]

    min_history_events = int(condition.get("min_history_events") or 3)
    min_distinct_locations = int(condition.get("min_distinct_locations") or 1)
    baseline_exclude_recent = int(condition.get("baseline_exclude_recent") or 1)

    grouped: dict[str, list[Event]] = {}
    for event in sorted(events, key=lambda item: item.timestamp):
        entity_value = (event.fields_json or {}).get(entity_field)
        if entity_value in {None, ""}:
            continue
        grouped.setdefault(str(entity_value), []).append(event)

    anomalies: list[Event] = []
    for grouped_events in grouped.values():
        if len(grouped_events) < max(min_history_events + baseline_exclude_recent, min_history_events + 1):
            continue

        baseline_events = grouped_events[:-baseline_exclude_recent] if baseline_exclude_recent > 0 else grouped_events[:-1]
        recent_events = grouped_events[-baseline_exclude_recent:] if baseline_exclude_recent > 0 else grouped_events[-1:]

        if len(baseline_events) < min_history_events:
            continue

        baseline_locations: set[str] = set()
        for baseline in baseline_events:
            parts: list[str] = []
            for field in location_fields:
                value = (baseline.fields_json or {}).get(str(field))
                parts.append(str(value) if value not in {None, ""} else "__missing__")
            baseline_locations.add("|".join(parts))

        if len(baseline_locations) < min_distinct_locations:
            continue

        for recent in recent_events:
            parts: list[str] = []
            for field in location_fields:
                value = (recent.fields_json or {}).get(str(field))
                parts.append(str(value) if value not in {None, ""} else "__missing__")
            location_key = "|".join(parts)
            if location_key not in baseline_locations:
                anomalies.append(recent)

    if not anomalies:
        return 0, None, None

    return len(anomalies), min(event.timestamp for event in anomalies), max(event.timestamp for event in anomalies)


def _calculate_correlation_confidence(rule: Rule, matched_count: int) -> tuple[float, str]:
    threshold_factor = min(1.0, matched_count / max(rule.threshold, 1))

    if rule.sequence_json:
        sequence_completeness = 1.0
    elif isinstance(rule.condition_json, dict) and rule.condition_json.get("type") == "geo_anomaly":
        sequence_completeness = 0.9
    else:
        sequence_completeness = 0.6

    severity_weight = {
        "critical": 1.0,
        "high": 0.9,
        "warning": 0.7,
        "medium": 0.7,
        "low": 0.5,
        "info": 0.4,
    }
    signal_strength = severity_weight.get(str(rule.severity).lower(), 0.6)

    condition = rule.condition_json if isinstance(rule.condition_json, dict) else {}
    if isinstance(condition.get("message_contains_any"), list) and len(condition["message_contains_any"]) >= 3:
        signal_strength = min(1.0, signal_strength + 0.1)
    if rule.sequence_json and len(rule.sequence_json) >= 3:
        signal_strength = min(1.0, signal_strength + 0.1)
    if rule.group_by_entity:
        signal_strength = min(1.0, signal_strength + 0.05)

    confidence = round(
        (0.35 * threshold_factor) + (0.35 * sequence_completeness) + (0.30 * signal_strength),
        2,
    )

    rationale = (
        f"threshold={matched_count}/{rule.threshold}, "
        f"sequence_completeness={sequence_completeness:.2f}, "
        f"signal_strength={signal_strength:.2f}"
    )
    return confidence, rationale


def _build_condition_clauses(condition: dict) -> list:
    """Convert a rule condition dict into SQLAlchemy WHERE expressions.

    All scalar-column conditions are pushed to the DB.
    The "field" condition (JSONB lookup) is NOT included here and
    must still be handled in Python via _matches_condition.
    """
    clauses = []
    if not condition:
        return clauses
    if "severity" in condition:
        clauses.append(Event.severity == condition["severity"])
    if "severity_in" in condition:
        clauses.append(Event.severity.in_(condition["severity_in"]))
    if "message_contains" in condition:
        clauses.append(Event.message.ilike(f"%{condition['message_contains']}%"))
    if "message_contains_any" in condition:
        needles = [n for n in condition["message_contains_any"] if n]
        if needles:
            clauses.append(or_(*[Event.message.ilike(f"%{needle}%") for needle in needles]))
    if "service" in condition:
        clauses.append(Event.service == condition["service"])
    if "host" in condition:
        clauses.append(Event.host == condition["host"])
    if "environment" in condition:
        clauses.append(Event.environment == condition["environment"])
    if "event_type" in condition:
        clauses.append(Event.event_type == condition["event_type"])
    return clauses


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

    if "message_contains_any" in condition:
        message = (event.message or "").lower()
        needles = [str(n).lower() for n in condition["message_contains_any"] if n]
        if needles and not any(needle in message for needle in needles):
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

    if isinstance(rule.condition_json, dict) and rule.condition_json.get("type") == "geo_anomaly":
        stmt = (
            select(Event)
            .where(Event.timestamp >= window_start, Event.timestamp <= now)
            .order_by(Event.timestamp.asc())
            .limit(_RULE_EVENT_LIMIT)
        )
        result = await session.execute(stmt)
        events = result.scalars().all()

        if len(events) == _RULE_EVENT_LIMIT:
            logger.warning(
                "rule_event_limit_reached",
                rule_id=rule.id,
                rule_name=rule.name,
                limit=_RULE_EVENT_LIMIT,
            )

        matched_count, _, _ = _evaluate_geo_anomaly_matches(events, rule.condition_json)
        return matched_count, matched_count >= rule.threshold

    if rule.sequence_json:
        stmt = (
            select(Event)
            .where(Event.timestamp >= window_start, Event.timestamp <= now)
            .order_by(Event.timestamp.asc())
            .limit(_RULE_EVENT_LIMIT)
        )
        result = await session.execute(stmt)
        events = result.scalars().all()

        if len(events) == _RULE_EVENT_LIMIT:
            logger.warning(
                "rule_event_limit_reached",
                rule_id=rule.id,
                rule_name=rule.name,
                limit=_RULE_EVENT_LIMIT,
            )

        matched_count, _, _ = _evaluate_sequence_matches(
            events,
            rule.sequence_json,
            rule.group_by_entity,
        )
        return matched_count, matched_count >= rule.threshold

    sql_clauses = _build_condition_clauses(rule.condition_json)
    stmt = (
        select(Event)
        .where(Event.timestamp >= window_start, Event.timestamp <= now, *sql_clauses)
        .limit(_RULE_EVENT_LIMIT)
    )
    result = await session.execute(stmt)
    events = result.scalars().all()

    if len(events) == _RULE_EVENT_LIMIT:
        logger.warning(
            "rule_event_limit_reached",
            rule_id=rule.id,
            rule_name=rule.name,
            limit=_RULE_EVENT_LIMIT,
        )

    # Python pass is only necessary for "field" (JSONB) conditions;
    # all column conditions are already enforced by the SQL WHERE clause.
    matched = [e for e in events if _matches_condition(e, rule.condition_json)]
    would_fire = len(matched) >= rule.threshold
    return len(matched), would_fire


async def fire_incident_if_needed(
    session: AsyncSession,
    rule: Rule,
    event_count: int,
    first_seen: datetime,
    last_seen: datetime,
    confidence_score: float | None = None,
    confidence_rationale: str | None = None,
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

    incident = Incident(
        title=f"Rule fired: {rule.name}",
        status="open",
        severity=rule.severity,
        first_seen=first_seen,
        last_seen=last_seen,
        event_count=event_count,
        rule_id=rule.id,
        mitre_techniques_json=rule.mitre_techniques_json,
        mitre_tactic=rule.mitre_tactic,
        confidence_score=confidence_score,
        confidence_rationale=confidence_rationale,
        summary=confidence_rationale,
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
        if isinstance(rule.condition_json, dict) and rule.condition_json.get("type") == "geo_anomaly":
            stmt = (
                select(Event)
                .where(Event.timestamp >= window_start, Event.timestamp <= now)
                .order_by(Event.timestamp.asc())
                .limit(_RULE_EVENT_LIMIT)
            )
            result = await session.execute(stmt)
            events = result.scalars().all()
            if len(events) == _RULE_EVENT_LIMIT:
                logger.warning(
                    "rule_event_limit_reached",
                    rule_id=rule.id,
                    rule_name=rule.name,
                    limit=_RULE_EVENT_LIMIT,
                )
            matched_count, first_seen, last_seen = _evaluate_geo_anomaly_matches(events, rule.condition_json)
        elif rule.sequence_json:
            stmt = (
                select(Event)
                .where(Event.timestamp >= window_start, Event.timestamp <= now)
                .order_by(Event.timestamp.asc())
                .limit(_RULE_EVENT_LIMIT)
            )
            result = await session.execute(stmt)
            events = result.scalars().all()
            if len(events) == _RULE_EVENT_LIMIT:
                logger.warning(
                    "rule_event_limit_reached",
                    rule_id=rule.id,
                    rule_name=rule.name,
                    limit=_RULE_EVENT_LIMIT,
                )
            matched_count, first_seen, last_seen = _evaluate_sequence_matches(
                events,
                rule.sequence_json,
                rule.group_by_entity,
            )
        else:
            sql_clauses = _build_condition_clauses(rule.condition_json)
            has_field_condition = "field" in rule.condition_json

            if not has_field_condition:
                # Pure SQL path: COUNT + MIN(ts) + MAX(ts) — no ORM objects loaded.
                stmt = select(
                    func.count(),
                    func.min(Event.timestamp),
                    func.max(Event.timestamp),
                ).where(Event.timestamp >= window_start, Event.timestamp <= now, *sql_clauses)
                result = await session.execute(stmt)
                row = result.one()
                matched_count, first_seen, last_seen = row[0], row[1], row[2]
            else:
                # JSONB field condition: load events with LIMIT + Python filter.
                stmt = (
                    select(Event)
                    .where(Event.timestamp >= window_start, Event.timestamp <= now, *sql_clauses)
                    .limit(_RULE_EVENT_LIMIT)
                )
                result = await session.execute(stmt)
                events = result.scalars().all()
                if len(events) == _RULE_EVENT_LIMIT:
                    logger.warning(
                        "rule_event_limit_reached",
                        rule_id=rule.id,
                        rule_name=rule.name,
                        limit=_RULE_EVENT_LIMIT,
                    )
                matched_events = [e for e in events if _matches_condition(e, rule.condition_json)]
                matched_count = len(matched_events)
                first_seen = min((e.timestamp for e in matched_events), default=now)
                last_seen = max((e.timestamp for e in matched_events), default=now)

        fired = matched_count >= rule.threshold
        incident = None

        if fired:
            confidence_score, confidence_rationale = _calculate_correlation_confidence(rule, matched_count)
            incident = await fire_incident_if_needed(
                session, rule, matched_count,
                first_seen or now, last_seen or now,
                confidence_score=confidence_score,
                confidence_rationale=confidence_rationale,
            )

        results.append({
            "rule_id": rule.id,
            "rule_name": rule.name,
            "matched": matched_count,
            "threshold": rule.threshold,
            "fired": fired,
            "incident_created": incident is not None,
        })

    return results
