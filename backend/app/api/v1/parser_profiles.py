"""CRUD endpoints for ParserProfile."""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app.domain.models import ParserProfile

router = APIRouter(prefix="/parser-profiles", tags=["parser-profiles"])


# ---------------------------------------------------------------------------
# Schemas (inlined – small surface)
# ---------------------------------------------------------------------------

class ParserProfileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    format: str
    pattern: Optional[str]
    mapping: dict[str, Any]
    priority: int
    enabled: bool
    created_at: Any
    updated_at: Any

    @classmethod
    def from_orm_obj(cls, obj: ParserProfile) -> "ParserProfileResponse":
        return cls(
            id=obj.id,
            name=obj.name,
            format=obj.format,
            pattern=obj.pattern,
            mapping=obj.mapping_json,
            priority=obj.priority,
            enabled=obj.enabled,
            created_at=obj.created_at,
            updated_at=obj.updated_at,
        )


class ParserProfileCreateRequest(BaseModel):
    name: str
    format: str  # json | regex | grok | kv
    pattern: Optional[str] = None
    mapping: dict[str, Any] = {}
    priority: int = 100
    enabled: bool = True


class ParserProfilePatchRequest(BaseModel):
    name: Optional[str] = None
    format: Optional[str] = None
    pattern: Optional[str] = None
    mapping: Optional[dict[str, Any]] = None
    priority: Optional[int] = None
    enabled: Optional[bool] = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("", summary="List parser profiles")
async def list_parser_profiles(
    session: AsyncSession = Depends(get_db),
) -> list[dict]:
    result = await session.execute(
        select(ParserProfile).order_by(ParserProfile.priority.asc(), ParserProfile.name.asc())
    )
    profiles = result.scalars().all()
    return [ParserProfileResponse.from_orm_obj(p).model_dump() for p in profiles]


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create parser profile")
async def create_parser_profile(
    body: ParserProfileCreateRequest,
    session: AsyncSession = Depends(get_db),
) -> dict:
    valid_formats = {"json", "regex", "grok", "kv"}
    if body.format not in valid_formats:
        raise HTTPException(status_code=422, detail=f"format must be one of {sorted(valid_formats)}")

    profile = ParserProfile(
        name=body.name,
        format=body.format,
        pattern=body.pattern,
        mapping_json=body.mapping,
        priority=body.priority,
        enabled=body.enabled,
    )
    session.add(profile)
    await session.commit()
    await session.refresh(profile)
    return ParserProfileResponse.from_orm_obj(profile).model_dump()


@router.patch("/{profile_id}", summary="Update parser profile")
async def patch_parser_profile(
    profile_id: str,
    body: ParserProfilePatchRequest,
    session: AsyncSession = Depends(get_db),
) -> dict:
    result = await session.execute(select(ParserProfile).where(ParserProfile.id == profile_id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="parser profile not found")

    if body.name is not None:
        profile.name = body.name
    if body.format is not None:
        valid_formats = {"json", "regex", "grok", "kv"}
        if body.format not in valid_formats:
            raise HTTPException(status_code=422, detail=f"format must be one of {sorted(valid_formats)}")
        profile.format = body.format
    if body.pattern is not None:
        profile.pattern = body.pattern
    if body.mapping is not None:
        profile.mapping_json = body.mapping
    if body.priority is not None:
        profile.priority = body.priority
    if body.enabled is not None:
        profile.enabled = body.enabled

    await session.commit()
    await session.refresh(profile)
    return ParserProfileResponse.from_orm_obj(profile).model_dump()


@router.delete("/{profile_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete parser profile")
async def delete_parser_profile(
    profile_id: str,
    session: AsyncSession = Depends(get_db),
) -> None:
    result = await session.execute(select(ParserProfile).where(ParserProfile.id == profile_id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="parser profile not found")
    await session.delete(profile)
    await session.commit()
