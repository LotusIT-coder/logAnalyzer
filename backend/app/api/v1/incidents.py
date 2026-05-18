"""Incidents endpoints – GET/PATCH/DELETE /api/v1/incidents, GET /{id}."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.source_filters import resolve_source_ids
from app.dependencies import get_db
from app.domain.models import Event, Incident, IncidentEvent, Rule
from app.schemas.domain import (
    IncidentListResponse,
    IncidentPatchRequest,
    IncidentResponse,
    MitreCoverageItem,
    MitreCoverageResponse,
)


_ARCHIVE_PATH = Path("data/runtime/mitre-reset-archive.jsonl")

_ACTIVE_STATUSES = {"open", "investigating"}


class MitreCoverageResetResponse(BaseModel):
    archived_count: int
    archive_file: Optional[str]
    timestamp: str

router = APIRouter(prefix="/incidents", tags=["Incidents"])

_VALID_STATUSES = {"open", "investigating", "resolved", "false_positive", "archived"}


@router.get("/mitre-coverage", response_model=MitreCoverageResponse)
async def get_mitre_coverage(
    session: AsyncSession = Depends(get_db),
):
    try:
        rules_result = await session.execute(
            select(Rule.mitre_techniques_json, Rule.mitre_tactic).where(Rule.mitre_techniques_json.is_not(None))
        )
        mapped_rules = list(rules_result.all())
    except ProgrammingError:
        await session.rollback()
        mapped_rules = []

    try:
        incidents_result = await session.execute(
            select(Incident.mitre_techniques_json, Incident.mitre_tactic).where(
                Incident.mitre_techniques_json.is_not(None),
                Incident.status.not_in(["archived", "false_positive"]),
            )
        )
        mapped_incidents = list(incidents_result.all())
    except ProgrammingError:
        await session.rollback()
        mapped_incidents = []

    coverage: dict[str, MitreCoverageItem] = {}

    def get_or_create_item(technique_id: str) -> MitreCoverageItem:
        if technique_id not in coverage:
            coverage[technique_id] = MitreCoverageItem(
                technique_id=technique_id,
                tactic=None,
                rule_count=0,
                incident_count=0,
            )
        return coverage[technique_id]

    for techniques_json, mitre_tactic in mapped_rules:
        techniques = {str(t).strip() for t in (techniques_json or []) if str(t).strip()}
        for technique in techniques:
            item = get_or_create_item(technique)
            item.rule_count += 1
            if not item.tactic and mitre_tactic:
                item.tactic = mitre_tactic

    for techniques_json, mitre_tactic in mapped_incidents:
        techniques = {str(t).strip() for t in (techniques_json or []) if str(t).strip()}
        for technique in techniques:
            item = get_or_create_item(technique)
            item.incident_count += 1
            if not item.tactic and mitre_tactic:
                item.tactic = mitre_tactic

    items = sorted(
        coverage.values(),
        key=lambda item: (-item.incident_count, -item.rule_count, item.technique_id),
    )
    return MitreCoverageResponse(
        items=items,
        mapped_rules=len(mapped_rules),
        mapped_incidents=len(mapped_incidents),
    )


@router.post("/mitre-coverage/reset", response_model=MitreCoverageResetResponse)
async def reset_mitre_coverage(
    session: AsyncSession = Depends(get_db),
):
    """Archive all active MITRE-mapped incidents to a JSONL file, then set them to 'archived'.

    Each reset appends one JSON record to ``data/runtime/mitre-reset-archive.jsonl``
    containing the full incident state, the associated rule definition, an inferred
    attack-path chain string, and up to 50 sample events per incident.
    """
    result = await session.execute(
        select(Incident)
        .where(
            Incident.mitre_techniques_json.is_not(None),
            Incident.status.not_in(["archived", "false_positive"]),
        )
        .options(
            selectinload(Incident.rule),
            selectinload(Incident.incident_events).selectinload(IncidentEvent.event),
        )
        .order_by(Incident.last_seen.desc())
    )
    incidents = list(result.scalars())

    reset_at = datetime.now(timezone.utc)

    if not incidents:
        return MitreCoverageResetResponse(
            archived_count=0,
            archive_file=None,
            timestamp=reset_at.isoformat(),
        )

    all_techniques: set[str] = set()
    tactic_breakdown: dict[str, int] = {}
    archive_records: list[dict[str, Any]] = []

    for incident in incidents:
        techniques: list[str] = incident.mitre_techniques_json or []
        all_techniques.update(techniques)
        tactic = incident.mitre_tactic or "unknown"
        tactic_breakdown[tactic] = tactic_breakdown.get(tactic, 0) + 1

        rule_data: dict[str, Any] | None = None
        rule_name = "Rule n/a"
        if incident.rule:
            r = incident.rule
            rule_name = r.name
            rule_data = {
                "id": r.id,
                "name": r.name,
                "description": r.description,
                "mitre_techniques": r.mitre_techniques_json,
                "mitre_tactic": r.mitre_tactic,
                "severity": r.severity,
                "threshold": r.threshold,
                "window_seconds": r.window_seconds,
                "condition": r.condition_json,
            }

        techniques_str = ", ".join(techniques) if techniques else "n/a"
        tactic_str = incident.mitre_tactic or "n/a"
        chain = (
            f"Events ({incident.event_count})"
            f" → Rule: {rule_name}"
            f" → Incident: {incident.title}"
            f" → MITRE: {techniques_str} ({tactic_str})"
        )

        sorted_ies = sorted(
            incident.incident_events,
            key=lambda ie: ie.event.timestamp,
            reverse=True,
        )[:50]
        sample_events: list[dict[str, Any]] = [
            {
                "id": ie.event.id,
                "timestamp": ie.event.timestamp.isoformat(),
                "severity": ie.event.severity,
                "host": ie.event.host,
                "service": ie.event.service,
                "message": ie.event.message,
            }
            for ie in sorted_ies
        ]

        archive_records.append({
            "id": incident.id,
            "title": incident.title,
            "status": incident.status,
            "severity": incident.severity,
            "first_seen": incident.first_seen.isoformat(),
            "last_seen": incident.last_seen.isoformat(),
            "event_count": incident.event_count,
            "mitre_techniques": techniques,
            "mitre_tactic": incident.mitre_tactic,
            "confidence_score": (
                float(incident.confidence_score) if incident.confidence_score is not None else None
            ),
            "confidence_rationale": incident.confidence_rationale,
            "summary": incident.summary,
            "assignee": incident.assignee,
            "tags": incident.tags_json,
            "rule": rule_data,
            "attack_path": {
                "technique_ids": techniques,
                "tactic": incident.mitre_tactic,
                "chain": chain,
            },
            "sample_events": sample_events,
        })

    archive_entry: dict[str, Any] = {
        "reset_at": reset_at.isoformat(),
        "summary": {
            "archived_count": len(incidents),
            "techniques": sorted(all_techniques),
            "tactic_breakdown": tactic_breakdown,
        },
        "incidents": archive_records,
    }

    _ARCHIVE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(_ARCHIVE_PATH, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(archive_entry, ensure_ascii=False) + "\n")

    for incident in incidents:
        incident.status = "archived"
        session.add(incident)
    await session.flush()

    return MitreCoverageResetResponse(
        archived_count=len(incidents),
        archive_file=str(_ARCHIVE_PATH),
        timestamp=reset_at.isoformat(),
    )


@router.get("", response_model=IncidentListResponse)
async def list_incidents(
    session: AsyncSession = Depends(get_db),
    status_filter: Optional[str] = Query(None, alias="status"),
    severity: Optional[str] = Query(None),
    source_ids: Optional[str] = Query(None),
    source_paths: Optional[str] = Query(None),
):
    resolved_source_ids = await resolve_source_ids(session, source_ids_csv=source_ids, source_paths_csv=source_paths)
    if resolved_source_ids == []:
        return IncidentListResponse(items=[])

    stmt = select(Incident).order_by(Incident.last_seen.desc())
    if status_filter:
        if status_filter not in _VALID_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid status. Must be one of: {sorted(_VALID_STATUSES)}",
            )
        stmt = stmt.where(Incident.status == status_filter)
    if severity:
        stmt = stmt.where(Incident.severity == severity)

    if resolved_source_ids is not None:
        stmt = (
            stmt
            .join(IncidentEvent, IncidentEvent.incident_id == Incident.id)
            .join(Event, Event.id == IncidentEvent.event_id)
            .where(Event.source_id.in_(resolved_source_ids))
            .distinct()
        )

    result = await session.execute(stmt)
    return IncidentListResponse(
        items=[IncidentResponse.model_validate(i) for i in result.scalars()]
    )


@router.get("/{incident_id}", response_model=IncidentResponse)
async def get_incident(
    incident_id: str,
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(Incident).where(Incident.id == incident_id))
    incident = result.scalar_one_or_none()
    if incident is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found.")
    return IncidentResponse.model_validate(incident)


@router.patch("/{incident_id}", response_model=IncidentResponse)
async def patch_incident(
    incident_id: str,
    body: IncidentPatchRequest,
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(Incident).where(Incident.id == incident_id))
    incident = result.scalar_one_or_none()
    if incident is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found.")

    if body.status is not None:
        if body.status not in _VALID_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid status. Must be one of: {sorted(_VALID_STATUSES)}",
            )
        incident.status = body.status
    if body.summary is not None:
        incident.summary = body.summary
    if body.assignee is not None:
        incident.assignee = body.assignee
    if body.tags is not None:
        incident.tags_json = body.tags

    session.add(incident)
    await session.flush()
    await session.refresh(incident)
    return IncidentResponse.model_validate(incident)


@router.post("/{incident_id}/archive", response_model=IncidentResponse)
async def archive_incident(
    incident_id: str,
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(Incident).where(Incident.id == incident_id))
    incident = result.scalar_one_or_none()
    if incident is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found.")

    incident.status = "archived"
    session.add(incident)
    await session.flush()
    await session.refresh(incident)
    return IncidentResponse.model_validate(incident)


@router.delete("/{incident_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_incident(
    incident_id: str,
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(Incident).where(Incident.id == incident_id))
    incident = result.scalar_one_or_none()
    if incident is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found.")

    await session.delete(incident)
    await session.flush()
