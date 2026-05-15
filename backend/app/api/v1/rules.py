"""Rules CRUD endpoints + dry-run."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app.domain.models import Rule
from app.schemas.domain import (
    RuleCreateRequest,
    RuleDryRunRequest,
    RuleDryRunResponse,
    RuleListResponse,
    RulePatchRequest,
    RuleResponse,
)
from app.services.rule_engine import evaluate_rule

router = APIRouter(prefix="/rules", tags=["Rules"])


@router.get("", response_model=RuleListResponse)
async def list_rules(session: AsyncSession = Depends(get_db)):
    result = await session.execute(select(Rule).order_by(Rule.created_at))
    return RuleListResponse(items=[RuleResponse.model_validate(r) for r in result.scalars()])


@router.post("", response_model=RuleResponse, status_code=status.HTTP_201_CREATED)
async def create_rule(
    body: RuleCreateRequest,
    session: AsyncSession = Depends(get_db),
):
    rule = Rule(
        name=body.name,
        description=body.description,
        condition_json=body.condition,
        sequence_json=body.sequence,
        group_by_entity=body.group_by_entity,
        mitre_techniques_json=body.mitre_techniques,
        mitre_tactic=body.mitre_tactic,
        threshold=body.threshold,
        window_seconds=body.window_seconds,
        severity=body.severity,
        enabled=body.enabled,
    )
    session.add(rule)
    await session.flush()
    await session.refresh(rule)
    return RuleResponse.model_validate(rule)


@router.patch("/{rule_id}", response_model=RuleResponse)
async def patch_rule(
    rule_id: str,
    body: RulePatchRequest,
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(Rule).where(Rule.id == rule_id))
    rule = result.scalar_one_or_none()
    if rule is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Rule not found.")

    if body.name is not None:
        rule.name = body.name
    if body.description is not None:
        rule.description = body.description
    if body.condition is not None:
        rule.condition_json = body.condition
    if body.sequence is not None:
        rule.sequence_json = body.sequence
    if body.group_by_entity is not None:
        rule.group_by_entity = body.group_by_entity
    if body.mitre_techniques is not None:
        rule.mitre_techniques_json = body.mitre_techniques
    if body.mitre_tactic is not None:
        rule.mitre_tactic = body.mitre_tactic
    if body.threshold is not None:
        rule.threshold = body.threshold
    if body.window_seconds is not None:
        rule.window_seconds = body.window_seconds
    if body.severity is not None:
        rule.severity = body.severity
    if body.enabled is not None:
        rule.enabled = body.enabled

    session.add(rule)
    await session.flush()
    await session.refresh(rule)
    return RuleResponse.model_validate(rule)


@router.delete("/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule(
    rule_id: str,
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(Rule).where(Rule.id == rule_id))
    rule = result.scalar_one_or_none()
    if rule is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Rule not found.")

    await session.delete(rule)
    await session.flush()


@router.post("/{rule_id}/dry-run", response_model=RuleDryRunResponse)
async def dry_run_rule(
    rule_id: str,
    body: Optional[RuleDryRunRequest] = None,
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(Rule).where(Rule.id == rule_id))
    rule = result.scalar_one_or_none()
    if rule is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Rule not found.")

    ref_time = (body.to if body and body.to else None) or datetime.now(timezone.utc)
    matched, would_fire = await evaluate_rule(session, rule, reference_time=ref_time)
    return RuleDryRunResponse(matched_events=matched, would_create_incident=would_fire)
