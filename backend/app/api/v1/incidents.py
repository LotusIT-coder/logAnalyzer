"""Incidents endpoints – GET/PATCH /api/v1/incidents, GET /{id}."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import require_scope
from app.dependencies import get_db
from app.domain.models import Incident
from app.schemas.domain import (
    IncidentListResponse,
    IncidentPatchRequest,
    IncidentResponse,
)

router = APIRouter(prefix="/incidents", tags=["Incidents"])

_read = Depends(require_scope("read"))
_write = Depends(require_scope("write"))

_VALID_STATUSES = {"open", "investigating", "resolved", "false_positive"}


@router.get("", response_model=IncidentListResponse)
async def list_incidents(
    _token=_read,
    session: AsyncSession = Depends(get_db),
    status_filter: Optional[str] = Query(None, alias="status"),
    severity: Optional[str] = Query(None),
):
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

    result = await session.execute(stmt)
    return IncidentListResponse(
        items=[IncidentResponse.model_validate(i) for i in result.scalars()]
    )


@router.get("/{incident_id}", response_model=IncidentResponse)
async def get_incident(
    incident_id: str,
    _token=_read,
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
    _token=_write,
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
