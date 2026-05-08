"""CRUD endpoints for ModelProfile."""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app.domain.models import ModelProfile

router = APIRouter(prefix="/model-profiles", tags=["model-profiles"])


# ---------------------------------------------------------------------------
# Schemas (inlined)
# ---------------------------------------------------------------------------

class ModelProfileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    purpose: str
    ollama_model: str
    temperature: float
    max_tokens: int
    system_prompt_template: str
    enabled: bool
    created_at: Any
    updated_at: Any

    @classmethod
    def from_orm_obj(cls, obj: ModelProfile) -> "ModelProfileResponse":
        return cls(
            id=obj.id,
            name=obj.name,
            purpose=obj.purpose,
            ollama_model=obj.ollama_model,
            temperature=float(obj.temperature),
            max_tokens=obj.max_tokens,
            system_prompt_template=obj.system_prompt_template,
            enabled=obj.enabled,
            created_at=obj.created_at,
            updated_at=obj.updated_at,
        )


class ModelProfileCreateRequest(BaseModel):
    name: str
    purpose: str  # triage | deep | security
    ollama_model: str
    temperature: float = 0.20
    max_tokens: int = 1024
    system_prompt_template: str
    enabled: bool = True


class ModelProfilePatchRequest(BaseModel):
    name: Optional[str] = None
    purpose: Optional[str] = None
    ollama_model: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    system_prompt_template: Optional[str] = None
    enabled: Optional[bool] = None


_VALID_PURPOSES = {"triage", "deep", "security"}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("", summary="List model profiles")
async def list_model_profiles(
    session: AsyncSession = Depends(get_db),
) -> list[dict]:
    result = await session.execute(
        select(ModelProfile).order_by(ModelProfile.name.asc())
    )
    profiles = result.scalars().all()
    return [ModelProfileResponse.from_orm_obj(p).model_dump() for p in profiles]


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create model profile")
async def create_model_profile(
    body: ModelProfileCreateRequest,
    session: AsyncSession = Depends(get_db),
) -> dict:
    if body.purpose not in _VALID_PURPOSES:
        raise HTTPException(status_code=422, detail=f"purpose must be one of {sorted(_VALID_PURPOSES)}")

    profile = ModelProfile(
        name=body.name,
        purpose=body.purpose,
        ollama_model=body.ollama_model,
        temperature=body.temperature,
        max_tokens=body.max_tokens,
        system_prompt_template=body.system_prompt_template,
        enabled=body.enabled,
    )
    session.add(profile)
    await session.commit()
    await session.refresh(profile)
    return ModelProfileResponse.from_orm_obj(profile).model_dump()


@router.patch("/{profile_id}", summary="Update model profile")
async def patch_model_profile(
    profile_id: str,
    body: ModelProfilePatchRequest,
    session: AsyncSession = Depends(get_db),
) -> dict:
    result = await session.execute(select(ModelProfile).where(ModelProfile.id == profile_id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="model profile not found")

    if body.name is not None:
        profile.name = body.name
    if body.purpose is not None:
        if body.purpose not in _VALID_PURPOSES:
            raise HTTPException(status_code=422, detail=f"purpose must be one of {sorted(_VALID_PURPOSES)}")
        profile.purpose = body.purpose
    if body.ollama_model is not None:
        profile.ollama_model = body.ollama_model
    if body.temperature is not None:
        profile.temperature = body.temperature
    if body.max_tokens is not None:
        profile.max_tokens = body.max_tokens
    if body.system_prompt_template is not None:
        profile.system_prompt_template = body.system_prompt_template
    if body.enabled is not None:
        profile.enabled = body.enabled

    await session.commit()
    await session.refresh(profile)
    return ModelProfileResponse.from_orm_obj(profile).model_dump()


@router.delete("/{profile_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete model profile")
async def delete_model_profile(
    profile_id: str,
    session: AsyncSession = Depends(get_db),
) -> None:
    result = await session.execute(select(ModelProfile).where(ModelProfile.id == profile_id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="model profile not found")
    await session.delete(profile)
    await session.commit()
