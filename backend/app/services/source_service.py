"""Source CRUD service layer."""
from __future__ import annotations

import os
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.models import Source
from app.schemas.source import SourceCreateRequest, SourcePatchRequest


async def list_sources(session: AsyncSession) -> List[Source]:
    result = await session.execute(select(Source).order_by(Source.created_at))
    return list(result.scalars().all())


async def get_source(session: AsyncSession, source_id: str) -> Optional[Source]:
    result = await session.execute(select(Source).where(Source.id == source_id))
    return result.scalar_one_or_none()


async def create_source(session: AsyncSession, body: SourceCreateRequest) -> Source:
    source = Source(
        name=body.name,
        type=body.type,
        config_json=body.config,
        enabled=body.enabled,
    )
    session.add(source)
    await session.flush()  # populate id / server defaults without committing yet
    await session.refresh(source)
    return source


async def patch_source(
    session: AsyncSession, source: Source, body: SourcePatchRequest
) -> Source:
    if body.name is not None:
        source.name = body.name
    if body.config is not None:
        source.config_json = body.config
    if body.enabled is not None:
        source.enabled = body.enabled
    session.add(source)
    await session.flush()
    await session.refresh(source)
    return source


async def delete_source(session: AsyncSession, source: Source) -> None:
    await session.delete(source)
    await session.flush()


def test_source(source: Source) -> tuple[bool, str]:
    """Check that the configured file path exists and is readable (MVP: file type only)."""
    if source.type != "file":
        return True, f"Source type '{source.type}' – no connectivity test available in MVP."

    path = source.config_json.get("path", "")
    if not path:
        return False, "config.path is missing."
    if not os.path.exists(path):
        return False, f"File not found: {path}"
    if not os.access(path, os.R_OK):
        return False, f"File not readable: {path}"
    return True, f"File accessible: {path}"
