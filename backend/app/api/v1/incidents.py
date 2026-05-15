"""Incidents endpoints – GET/PATCH/DELETE /api/v1/incidents, GET /{id}."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

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
            select(Incident.mitre_techniques_json, Incident.mitre_tactic).where(Incident.mitre_techniques_json.is_not(None))
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
