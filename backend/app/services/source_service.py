"""Source CRUD service layer."""
from __future__ import annotations

import os
import re
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.models import Source
from app.schemas.source import SourceCreateRequest, SourcePatchRequest


async def list_sources(session: AsyncSession) -> List[Source]:
    result = await session.execute(select(Source).order_by(Source.created_at))
    return list(result.scalars().all())


async def get_source(session: AsyncSession, source_id: str) -> Optional[Source]:
    result = await session.execute(select(Source).where(Source.id == source_id))
    return result.scalar_one_or_none()


class DuplicateSourceNameError(ValueError):
    pass


async def create_source(session: AsyncSession, body: SourceCreateRequest) -> Source:
    source = Source(
        name=body.name,
        type=body.type,
        config_json=body.config,
        enabled=body.enabled,
    )
    session.add(source)
    try:
        await session.flush()  # populate id / server defaults without committing yet
    except IntegrityError:
        await session.rollback()
        raise DuplicateSourceNameError(body.name)
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

    path, err = resolve_source_path(source)
    if err:
        return False, err
    if path is None:
        return False, "No matching file resolved for source."
    if not os.access(path, os.R_OK):
        return False, f"File not readable: {path}"
    return True, f"File accessible: {path}"


def get_source_config_path(source: Source) -> str:
    cfg = source.config_json or {}
    return (
        cfg.get("path")
        or cfg.get("log_path")
        or cfg.get("docker_log_path")
        or cfg.get("journal_path")
        or ""
    )


def source_path_is_regex(source: Source) -> bool:
    cfg = source.config_json or {}
    return bool(cfg.get("path_regex") or cfg.get("use_regex") or cfg.get("regex"))


def resolve_source_path(source: Source) -> tuple[Optional[str], Optional[str]]:
    """Resolve configured source path to an existing file.

    If `config.path_regex` is true, `config.path` is treated as a regex for the
    filename inside its directory and the most recently modified matching file is
    returned.
    """
    raw_path = get_source_config_path(source)
    if not raw_path:
        return None, "config.path is missing."

    if not source_path_is_regex(source):
        if not os.path.exists(raw_path):
            return None, f"File not found: {raw_path}"
        return raw_path, None

    base_dir = os.path.dirname(raw_path) or "."
    name_pattern = os.path.basename(raw_path)
    if not name_pattern:
        return None, f"Invalid regex path (missing filename pattern): {raw_path}"
    if not os.path.isdir(base_dir):
        return None, f"Directory not found: {base_dir}"

    try:
        compiled = re.compile(name_pattern)
    except re.error as exc:
        return None, f"Invalid regex in path '{raw_path}': {exc}"

    matches: list[tuple[str, float]] = []
    try:
        with os.scandir(base_dir) as entries:
            for entry in entries:
                if not entry.is_file():
                    continue
                if compiled.fullmatch(entry.name):
                    matches.append((entry.path, entry.stat().st_mtime))
    except OSError as exc:
        return None, f"Failed to list directory '{base_dir}': {exc}"

    if not matches:
        return None, f"No files match regex path: {raw_path}"

    matches.sort(key=lambda item: (item[1], item[0]), reverse=True)
    return matches[0][0], None
