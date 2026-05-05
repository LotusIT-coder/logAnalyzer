"""File-based log ingestion with cursor tracking.

Cursor strategy: store the byte-offset of the last ingested line in raw_log.cursor.
On each run we seek to the stored offset so we only read new lines (tail-like).
If the file is smaller than the cursor (log rotation), we reset to 0.
"""
from __future__ import annotations

import hashlib
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.models import Event, ParserProfile, RawLog, Source
from app.parser.pipeline import parse_line


_MAX_LINES_PER_RUN = 10_000  # safety cap per source per ingestion cycle


async def _get_last_cursor(session: AsyncSession, source_id: str) -> Optional[int]:
    """Return the byte offset stored in the most-recently ingested raw_log row."""
    result = await session.execute(
        select(RawLog.cursor)
        .where(RawLog.source_id == source_id, RawLog.cursor.isnot(None))
        .order_by(RawLog.ingested_at.desc())
        .limit(1)
    )
    row = result.scalar_one_or_none()
    if row is None:
        return None
    try:
        return int(row)
    except (ValueError, TypeError):
        return None


def _line_hash(line: str) -> str:
    return hashlib.sha256(line.encode()).hexdigest()


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
    if source.type != "file":
        return {"source_id": source.id, "skipped": True, "reason": "non-file source"}

    path: str = source.config_json.get("path", "")
    if not path or not os.path.exists(path):
        return {"source_id": source.id, "skipped": True, "reason": f"file not found: {path}"}

    file_size = os.path.getsize(path)
    last_cursor = await _get_last_cursor(session, source.id)

    # Handle log rotation: file shrunk since last read
    start_offset = 0 if (last_cursor is None or last_cursor > file_size) else last_cursor

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

            row = RawLog(
                source_id=source.id,
                raw_line=stripped,
                raw_hash=_line_hash(stripped),
                cursor=str(fh.tell()),
            )
            session.add(row)
            new_cursor = fh.tell()
            lines_ingested += 1

            # Attempt parsing with first matching profile
            parsed: Optional[Dict[str, Any]] = None
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

            event = Event(
                source_id=source.id,
                timestamp=ts,
                severity=parsed.get("severity", "info"),
                service=parsed.get("service"),
                host=parsed.get("host"),
                environment=parsed.get("environment"),
                event_type=parsed.get("event_type"),
                message=parsed.get("message", stripped),
                fields_json={
                    k: v for k, v in parsed.items()
                    if k not in {"timestamp", "severity", "service", "host",
                                 "environment", "event_type", "message"}
                },
            )
            session.add(event)
            events_created += 1

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
