"""Audit endpoint – GET /api/v1/audit (admin scope)."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import require_scope
from app.dependencies import get_db
from app.domain.models import AuditLog
from app.schemas.domain import AuditListResponse, AuditLogResponse

router = APIRouter(prefix="/audit", tags=["Audit"])


@router.get("", response_model=AuditListResponse)
async def list_audit(
    _token=Depends(require_scope("admin")),
    session: AsyncSession = Depends(get_db),
    from_: Optional[datetime] = Query(None, alias="from"),
    to: Optional[datetime] = Query(None),
):
    stmt = select(AuditLog).order_by(AuditLog.created_at.desc()).limit(500)
    if from_:
        stmt = stmt.where(AuditLog.created_at >= from_)
    if to:
        stmt = stmt.where(AuditLog.created_at <= to)

    result = await session.execute(stmt)
    return AuditListResponse(
        items=[AuditLogResponse.model_validate(row) for row in result.scalars()]
    )
