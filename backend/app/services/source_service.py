"""Source CRUD service layer."""
from __future__ import annotations

import os
import re
import subprocess
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.models import Source
from app.schemas.source import SourceCreateRequest, SourcePatchRequest


HOSTFS_PREFIX = "/hostfs"


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
    if source.type == "journald" and not get_source_config_path(source):
        cfg = source.config_json or {}
        command = ["journalctl", "--no-pager", "--output=json", "-n", "1"]
        unit = cfg.get("unit")
        if isinstance(unit, str) and unit.strip():
            command.extend(["-u", unit.strip()])
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "journalctl failed").strip()
            return False, detail
        return True, "journalctl accessible for this source."

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
    paths = get_source_config_paths(source)
    return paths[0] if paths else ""


def get_source_config_paths(source: Source) -> list[str]:
    cfg = source.config_json or {}
    values = [
        cfg.get("path"),
        cfg.get("log_path"),
        cfg.get("docker_log_path"),
        cfg.get("journal_path"),
    ]
    paths: list[str] = []
    for value in values:
        if not isinstance(value, str) or not value:
            continue
        if value not in paths:
            paths.append(value)
    return paths


def source_path_is_regex(source: Source) -> bool:
    cfg = source.config_json or {}
    return bool(cfg.get("path_regex") or cfg.get("use_regex") or cfg.get("regex"))


def _expand_candidate_paths(paths: list[str]) -> list[str]:
    """Return path candidates including host-mounted fallback paths.

    In dockerized deployments host paths are available below /hostfs when the
    host root is mounted read-only. This keeps manual source paths working
    without rewriting persisted config values.
    """
    expanded: list[str] = []
    for path in paths:
        if path not in expanded:
            expanded.append(path)
        if path.startswith("/"):
            mapped = os.path.join(HOSTFS_PREFIX, path.lstrip("/"))
            if mapped not in expanded:
                expanded.append(mapped)
    return expanded


def resolve_source_path(source: Source) -> tuple[Optional[str], Optional[str]]:
    """Resolve configured source path to an existing file.

    If `config.path_regex` is true, `config.path` is treated as a regex for the
    filename inside its directory and the most recently modified matching file is
    returned.
    """
    configured_paths = get_source_config_paths(source)
    candidate_paths = _expand_candidate_paths(configured_paths)
    if not candidate_paths:
        return None, "config.path is missing."

    if not source_path_is_regex(source):
        for candidate_path in candidate_paths:
            if os.path.exists(candidate_path):
                return candidate_path, None
        return None, f"File not found: {configured_paths[0]}"

    last_error: str | None = None
    for raw_path in configured_paths:
        for candidate_path in _expand_candidate_paths([raw_path]):
            base_dir = os.path.dirname(candidate_path) or "."
            name_pattern = os.path.basename(candidate_path)
            if not name_pattern:
                last_error = f"Invalid regex path (missing filename pattern): {raw_path}"
                continue
            if not os.path.isdir(base_dir):
                last_error = f"Directory not found: {os.path.dirname(raw_path) or '.'}"
                continue

            try:
                compiled = re.compile(name_pattern)
            except re.error as exc:
                last_error = f"Invalid regex in path '{raw_path}': {exc}"
                continue

            matches: list[tuple[str, float]] = []
            try:
                with os.scandir(base_dir) as entries:
                    for entry in entries:
                        if not entry.is_file():
                            continue
                        if compiled.fullmatch(entry.name):
                            matches.append((entry.path, entry.stat().st_mtime))
            except OSError as exc:
                last_error = f"Failed to list directory '{os.path.dirname(raw_path) or '.'}': {exc}"
                continue

            if not matches:
                last_error = f"No files match regex path: {raw_path}"
                continue

            matches.sort(key=lambda item: (item[1], item[0]), reverse=True)
            return matches[0][0], None

    return None, last_error or f"No files match regex path: {configured_paths[0]}"
