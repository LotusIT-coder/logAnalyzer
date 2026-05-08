"""File-based log ingestion with cursor tracking.

Cursor strategy: store the byte-offset of the last ingested line in raw_log.cursor.
On each run we seek to the stored offset so we only read new lines (tail-like).
If the file is smaller than the cursor (log rotation), we reset to 0.
"""
from __future__ import annotations

import hashlib
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.models import Event, ParserProfile, RawLog, Source
from app.parser.pipeline import parse_line
from app.services.source_service import resolve_source_path, source_path_is_regex


_MAX_LINES_PER_RUN = 10_000  # safety cap per source per ingestion cycle
_BATCH_SIZE = 200         # rows bulk-inserted and released per partial flush
_PATH_BASED_SOURCE_TYPES = {"file", "docker", "journald"}
_JOURNALD_PRIORITY_MAP = {
    "0": "critical",
    "1": "critical",
    "2": "critical",
    "3": "error",
    "4": "warning",
    "5": "info",
    "6": "info",
    "7": "debug",
}


async def _get_last_cursor(session: AsyncSession, source_id: str) -> tuple[Optional[str], Optional[int]]:
    """Return (path, byte_offset) from the most-recent raw_log cursor row.

    Backward compatibility:
    - old format: "<offset>"
    - new format: "<path>\t<offset>"
    """
    result = await session.execute(
        select(RawLog.cursor)
        .where(RawLog.source_id == source_id, RawLog.cursor.isnot(None))
        .order_by(RawLog.ingested_at.desc())
        .limit(1)
    )
    row = result.scalar_one_or_none()
    if row is None:
        return None, None
    row_str = str(row)
    if "\t" in row_str:
        maybe_path, maybe_off = row_str.rsplit("\t", 1)
        try:
            return maybe_path, int(maybe_off)
        except (ValueError, TypeError):
            return maybe_path, None
    try:
        return None, int(row_str)
    except (ValueError, TypeError):
        return None, None


def _line_hash(line: str) -> str:
    return hashlib.sha256(line.encode()).hexdigest()


def _parse_specialized_source_line(source: Source, line: str) -> Optional[Dict[str, Any]]:
    if source.type == "docker":
        parsed = parse_line(line, "json", None, {"log": "message", "time": "timestamp"})
        if parsed is not None and isinstance(parsed.get("message"), str):
            parsed["message"] = parsed["message"].rstrip("\r\n")
        return parsed

    if source.type == "journald":
        parsed = parse_line(
            line,
            "json",
            None,
            {
                "MESSAGE": "message",
                "_HOSTNAME": "host",
                "SYSLOG_IDENTIFIER": "service",
                "__REALTIME_TIMESTAMP": "timestamp",
                "PRIORITY": "severity",
            },
        )
        if parsed is not None:
            priority = str(parsed.get("severity", "")).strip()
            if priority in _JOURNALD_PRIORITY_MAP:
                parsed["severity"] = _JOURNALD_PRIORITY_MAP[priority]
        return parsed

    return None


# ISO 8601 rsyslog: "2026-05-03T00:00:02.097521+02:00 hostname process[pid]: message"
_SYSLOG_ISO_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z))\s+"
    r"(\S+)\s+(\S+?)(?:\[(\d+)\])?:\s*(.*)",
    re.DOTALL,
)
# RFC3164 syslog: "May  3 11:19:56 hostname process[pid]: message"
_SYSLOG_RFC_RE = re.compile(
    r"^(\w{3}\s{1,2}\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\S+?)(?:\[(\d+)\])?:\s*(.*)",
    re.DOTALL,
)
_SYSLOG_MONTHS = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}


def _parse_syslog_header(line: str) -> Optional[Dict[str, Any]]:
    """Try to extract timestamp/host/service/message from a syslog line (ISO or RFC3164)."""
    # Try ISO 8601 first (modern rsyslog default)
    m = _SYSLOG_ISO_RE.match(line)
    if m:
        ts_str, host, service, _pid, message = m.groups()
        try:
            ts = datetime.fromisoformat(ts_str)
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
        except ValueError:
            ts = datetime.now(timezone.utc)
        return {"timestamp": ts, "host": host, "service": service.rstrip(":"), "message": message.strip()}

    # Fallback: RFC3164
    m = _SYSLOG_RFC_RE.match(line)
    if not m:
        return None
    ts_str, host, service, _pid, message = m.groups()
    parts = ts_str.split()
    if len(parts) != 3:
        return None
    month_num = _SYSLOG_MONTHS.get(parts[0])
    if not month_num:
        return None
    try:
        day = int(parts[1])
        hh, mm, ss = map(int, parts[2].split(":"))
        year = datetime.now(timezone.utc).year
        ts = datetime(year, month_num, day, hh, mm, ss, tzinfo=timezone.utc)
    except ValueError:
        return None
    return {"timestamp": ts, "host": host, "service": service.rstrip(":"), "message": message.strip()}


async def ingest_source(session: AsyncSession, source: Source) -> dict:
    """Read new lines from a file source, persist raw_log rows, return stats."""
    if source.type not in _PATH_BASED_SOURCE_TYPES:
        return {"source_id": source.id, "skipped": True, "reason": "non-file source"}

    path, path_err = resolve_source_path(source)
    if path_err or not path:
        return {
            "source_id": source.id,
            "skipped": True,
            "reason": path_err or "file path could not be resolved",
        }

    file_size = os.path.getsize(path)
    last_path, last_cursor = await _get_last_cursor(session, source.id)

    # Handle rotation and regex filename changes safely.
    if last_cursor is None:
        start_offset = 0
    elif last_cursor > file_size:
        start_offset = 0
    elif last_path is not None and last_path != path:
        start_offset = 0
    elif last_path is None and source_path_is_regex(source):
        # Legacy cursor format had no path info; with regex we cannot verify if
        # the filename changed, so we ingest from start once to avoid skipping.
        start_offset = 0
    else:
        start_offset = last_cursor

    # Load enabled parser profiles ordered by priority
    profiles_result = await session.execute(
        select(ParserProfile)
        .where(ParserProfile.enabled == True)  # noqa: E712
        .order_by(ParserProfile.priority.asc())
    )
    profiles: List[ParserProfile] = list(profiles_result.scalars().all())

    lines_ingested = 0
    events_created = 0
    new_cursor = start_offset
    now = datetime.now(timezone.utc)

    # Use plain dicts + bulk insert to avoid accumulating thousands of ORM
    # objects in the session identity map (the primary memory-growth path).
    _raw_batch: list[dict] = []
    _evt_batch: list[dict] = []

    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        fh.seek(start_offset)
        while lines_ingested < _MAX_LINES_PER_RUN:
            raw_line = fh.readline()
            if not raw_line:
                break  # EOF
            stripped = raw_line.rstrip("\n")
            if not stripped:
                new_cursor = fh.tell()
                continue

            new_cursor = fh.tell()
            _raw_batch.append({
                "id": str(uuid.uuid4()),
                "source_id": source.id,
                "raw_line": stripped,
                "raw_hash": _line_hash(stripped),
                "cursor": f"{path}\t{new_cursor}",
            })
            lines_ingested += 1

            parsed = _parse_specialized_source_line(source, stripped)

            # Attempt parsing with first matching profile
            if parsed is None:
                for profile in profiles:
                    parsed = parse_line(stripped, profile.format, profile.pattern, profile.mapping_json)
                    if parsed is not None:
                        break

            # Syslog RFC3164 pre-parser: extracts real timestamp/host/service/message
            syslog_base = _parse_syslog_header(stripped)
            if syslog_base:
                # Merge: syslog_base wins for ts/host/service, kv wins for extra fields
                kv_extra = parse_line(syslog_base["message"], "kv", None, None) or {}
                kv_extra.pop("timestamp", None)
                kv_extra.pop("host", None)
                kv_extra.pop("service", None)
                if parsed is None:
                    parsed = {**kv_extra, **syslog_base}
                else:
                    # Profile parser ran on full line; patch in real timestamp/host/service
                    parsed.setdefault("timestamp", syslog_base["timestamp"])
                    parsed.setdefault("host", syslog_base["host"])
                    parsed.setdefault("service", syslog_base["service"])
                    if not parsed.get("message"):
                        parsed["message"] = syslog_base["message"]

            # Final fallback: try auto JSON → kv on full line
            if parsed is None:
                parsed = parse_line(stripped, "json", None, None)
            if parsed is None:
                parsed = parse_line(stripped, "kv", None, None)

            # Fallback: keep every non-empty log line as an event.
            if parsed is None:
                parsed = {
                    "timestamp": now,
                    "severity": "info",
                    "service": source.name,
                    "message": stripped,
                }

            ts_raw = parsed.get("timestamp")
            if ts_raw and isinstance(ts_raw, str):
                try:
                    from datetime import datetime as _dt
                    ts = _dt.fromisoformat(ts_raw.replace("Z", "+00:00"))
                except ValueError:
                    ts = now
            elif isinstance(ts_raw, datetime):
                ts = ts_raw
            else:
                ts = now

            _evt_batch.append({
                "id": str(uuid.uuid4()),
                "source_id": source.id,
                "timestamp": ts,
                "severity": parsed.get("severity", "info"),
                "service": parsed.get("service"),
                "host": parsed.get("host"),
                "environment": parsed.get("environment"),
                "event_type": parsed.get("event_type"),
                "message": parsed.get("message", stripped),
                "fields_json": {
                    k: v for k, v in parsed.items()
                    if k not in {"timestamp", "severity", "service", "host",
                                 "environment", "event_type", "message"}
                },
            })
            events_created += 1

            # Periodically bulk-insert and drop references so the session
            # identity map never holds more than _BATCH_SIZE ORM objects.
            if lines_ingested % _BATCH_SIZE == 0:
                await session.execute(insert(RawLog), _raw_batch)
                await session.execute(insert(Event), _evt_batch)
                _raw_batch.clear()
                _evt_batch.clear()

    # Flush the final partial batch (< _BATCH_SIZE rows).
    if _raw_batch:
        await session.execute(insert(RawLog), _raw_batch)
        await session.execute(insert(Event), _evt_batch)

    return {
        "source_id": str(source.id),
        "path": (source.config_json or {}).get("path", ""),
        "lines_ingested": lines_ingested,
        "events_created": events_created,
        "start_offset": start_offset,
        "end_offset": new_cursor,
    }


async def run_ingestion(session: AsyncSession) -> list[dict]:
    """Run ingestion for all enabled file sources. Returns per-source stats."""
    from app.services.source_service import list_sources  # local import to avoid circular

    sources = await list_sources(session)
    results = []
    for source in sources:
        if not source.enabled:
            continue
        stats = await ingest_source(session, source)
        results.append(stats)
    return results
