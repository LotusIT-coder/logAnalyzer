from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.models import Source


def parse_csv(value: Optional[str]) -> list[str]:
    if not value:
        return []
    return [entry.strip() for entry in value.split(",") if entry.strip()]


async def resolve_source_ids(
    session: AsyncSession,
    source_id: Optional[str] = None,
    source_ids_csv: Optional[str] = None,
    source_paths_csv: Optional[str] = None,
) -> Optional[list[str]]:
    resolved_ids = set(parse_csv(source_ids_csv))
    if source_id:
        resolved_ids.add(source_id)

    source_paths = parse_csv(source_paths_csv)
    if source_paths:
        path_result = await session.execute(
            select(Source.id).where(Source.config_json["path"].as_string().in_(source_paths))
        )
        resolved_ids.update(path_result.scalars().all())

    if source_id or source_ids_csv or source_paths_csv:
        return list(resolved_ids)

    return None