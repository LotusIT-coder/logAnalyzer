"""File-based log ingestion with cursor tracking.

Cursor strategy: store the byte-offset of the last ingested line in raw_log.cursor.
On each run we seek to the stored offset so we only read new lines (tail-like).
If the file is smaller than the cursor (log rotation), we reset to 0.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.models import Event, EventIndexOutbox, ParserProfile, RawLog, Source
from app.parser.pipeline import parse_line
from app.services.source_service import get_source_config_path, resolve_source_path, source_path_is_regex


_MAX_LINES_PER_RUN = 10_000  # safety cap per source per ingestion cycle
_BATCH_SIZE = 200         # rows bulk-inserted and released per partial flush
_PATH_BASED_SOURCE_TYPES = {"file", "docker"}
# If backlog is huge, skip ahead close to EOF to prioritize near-real-time data.
_MAX_BACKLOG_BYTES_BEFORE_FAST_FORWARD = 20_000_000
_FAST_FORWARD_TAIL_BYTES = 2_000_000
_JOURNAL_CURSOR_PREFIX = "journal\t"
_JOURNAL_CURSOR_CHECKPOINT_LINE = "__journal_cursor_checkpoint__"
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


async def _get_last_journal_cursor(session: AsyncSession, source_id: str) -> Optional[str]:
    # Prefer explicit checkpoint rows. A large bulk insert can assign identical
    # ingested_at values to many raw rows, which makes ordering ambiguous.
    checkpoint = await session.execute(
        select(RawLog.cursor)
        .where(
            RawLog.source_id == source_id,
            RawLog.cursor.isnot(None),
            RawLog.raw_line == _JOURNAL_CURSOR_CHECKPOINT_LINE,
        )
        .order_by(RawLog.ingested_at.desc())
        .limit(1)
    )
    checkpoint_row = checkpoint.scalar_one_or_none()
    if checkpoint_row is not None:
        cursor = str(checkpoint_row)
        if cursor.startswith(_JOURNAL_CURSOR_PREFIX):
            return cursor[len(_JOURNAL_CURSOR_PREFIX):]
        return cursor or None

    result = await session.execute(
        select(RawLog.cursor)
        .where(RawLog.source_id == source_id, RawLog.cursor.isnot(None))
        .order_by(RawLog.ingested_at.desc())
        .limit(1)
    )
    row = result.scalar_one_or_none()
    if row is None:
        return None
    cursor = str(row)
    if cursor.startswith(_JOURNAL_CURSOR_PREFIX):
        return cursor[len(_JOURNAL_CURSOR_PREFIX):]
    return cursor or None


def _line_hash(line: str) -> str:
    return hashlib.sha256(line.encode()).hexdigest()


async def _enqueue_event_index_outbox(session: AsyncSession, event_rows: list[dict]) -> None:
    if not event_rows:
        return
    await session.execute(
        insert(EventIndexOutbox),
        [
            {
                "id": str(uuid.uuid4()),
                "event_id": row["id"],
                "payload_json": {},
                "attempts": 0,
            }
            for row in event_rows
        ],
    )


def _map_journald_entry(entry: Dict[str, Any]) -> Dict[str, Any]:
    raw_timestamp = entry.get("__REALTIME_TIMESTAMP")
    timestamp = datetime.now(timezone.utc)
    if isinstance(raw_timestamp, str) and raw_timestamp.isdigit():
        timestamp = datetime.fromtimestamp(int(raw_timestamp) / 1_000_000, tz=timezone.utc)
    elif isinstance(raw_timestamp, (int, float)):
        timestamp = datetime.fromtimestamp(float(raw_timestamp) / 1_000_000, tz=timezone.utc)
    elif isinstance(raw_timestamp, str):
        try:
            timestamp = datetime.fromisoformat(raw_timestamp.replace("Z", "+00:00"))
        except ValueError:
            pass

    priority = str(entry.get("PRIORITY", "")).strip()
    severity = _JOURNALD_PRIORITY_MAP.get(priority, "info")
    message = entry.get("MESSAGE")
    if isinstance(message, list):
        # journald can emit MESSAGE as a byte-array in JSON output.
        # Decode it so downstream full-text search can match real content.
        if all(isinstance(part, int) and 0 <= part <= 255 for part in message):
            message = bytes(message).decode("utf-8", errors="replace")
        else:
            message = " ".join(str(part) for part in message)
    if not isinstance(message, str) or not message.strip():
        message = str(entry.get("MESSAGE", "")) or "journal entry"

    return {
        "timestamp": timestamp,
        "severity": severity,
        "service": entry.get("SYSLOG_IDENTIFIER") or entry.get("_COMM") or entry.get("_SYSTEMD_UNIT"),
        "host": entry.get("_HOSTNAME"),
        "message": message.rstrip("\r\n"),
        "fields_json": {
            key: value
            for key, value in entry.items()
            if key not in {"__CURSOR", "__REALTIME_TIMESTAMP", "PRIORITY", "MESSAGE", "SYSLOG_IDENTIFIER", "_COMM", "_SYSTEMD_UNIT", "_HOSTNAME"}
        },
        "cursor": entry.get("__CURSOR"),
    }


def _build_journalctl_command(source: Source, after_cursor: Optional[str] = None) -> list[str]:
    cfg = source.config_json or {}
    command = ["journalctl", "--no-pager", "--output=json"]
    if cfg.get("boot_only", True):
        command.append("-b")
    unit = cfg.get("unit")
    if isinstance(unit, str) and unit.strip():
        command.extend(["-u", unit.strip()])
    command.extend(["-n", str(_MAX_LINES_PER_RUN)])
    if after_cursor:
        command.append(f"--after-cursor={after_cursor}")
    return command


async def _ingest_live_journald_source(session: AsyncSession, source: Source) -> dict:
    last_cursor = await _get_last_journal_cursor(session, source.id)
    latest_cursor = last_cursor
    command = _build_journalctl_command(source, after_cursor=last_cursor)
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()

    if process.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip() or "journalctl failed"
        return {
            "source_id": str(source.id),
            "skipped": True,
            "reason": detail,
        }

    lines_ingested = 0
    events_created = 0
    raw_batch: list[dict] = []
    evt_batch: list[dict] = []

    for line in stdout.decode("utf-8", errors="replace").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            entry = json.loads(stripped)
        except json.JSONDecodeError:
            continue

        mapped = _map_journald_entry(entry)
        cursor = mapped.pop("cursor", None)
        if not cursor:
            continue
        latest_cursor = cursor

        raw_batch.append({
            "id": str(uuid.uuid4()),
            "source_id": source.id,
            "raw_line": stripped,
            "raw_hash": _line_hash(stripped),
            "cursor": f"{_JOURNAL_CURSOR_PREFIX}{cursor}",
        })
        evt_batch.append({
            "id": str(uuid.uuid4()),
            "source_id": source.id,
            "timestamp": mapped["timestamp"],
            "severity": mapped["severity"],
            "service": mapped.get("service"),
            "host": mapped.get("host"),
            "environment": None,
            "event_type": None,
            "message": mapped["message"],
            "fields_json": mapped["fields_json"],
        })
        lines_ingested += 1
        events_created += 1

        if lines_ingested % _BATCH_SIZE == 0:
            await session.execute(insert(RawLog), raw_batch)
            await session.execute(insert(Event), evt_batch)
            await _enqueue_event_index_outbox(session, evt_batch)
            raw_batch.clear()
            evt_batch.clear()

    if raw_batch:
        await session.execute(insert(RawLog), raw_batch)
        await session.execute(insert(Event), evt_batch)
        await _enqueue_event_index_outbox(session, evt_batch)

    # Persist one deterministic cursor checkpoint row per run so the next
    # iteration can continue exactly from the newest processed journald entry.
    if latest_cursor:
        checkpoint_cursor = f"{_JOURNAL_CURSOR_PREFIX}{latest_cursor}"
        await session.execute(
            insert(RawLog),
            [{
                "id": str(uuid.uuid4()),
                "source_id": source.id,
                "raw_line": _JOURNAL_CURSOR_CHECKPOINT_LINE,
                "raw_hash": _line_hash(f"{_JOURNAL_CURSOR_CHECKPOINT_LINE}:{checkpoint_cursor}"),
                "cursor": checkpoint_cursor,
            }],
        )

    return {
        "source_id": str(source.id),
        "lines_ingested": lines_ingested,
        "events_created": events_created,
        "fast_forwarded": False,
        "start_offset": 0,
        "new_cursor": latest_cursor,
    }


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
    config_path = get_source_config_path(source)

    if source.type == "journald" and not config_path:
        return await _ingest_live_journald_source(session, source)

    if source.type not in _PATH_BASED_SOURCE_TYPES and not (source.type == "journald" and config_path):
        return {"source_id": source.id, "skipped": True, "reason": "non-file source"}

    path, path_err = resolve_source_path(source)
    if path_err or not path:
        return {
            "source_id": source.id,
            "skipped": True,
            "reason": path_err or "file path could not be resolved",
        }

    try:
        file_size = os.path.getsize(path)
    except PermissionError:
        return {
            "source_id": str(source.id),
            "skipped": True,
            "reason": f"no read permission for {path}; start the backend with access to this file",
        }
    except OSError as exc:
        return {
            "source_id": str(source.id),
            "skipped": True,
            "reason": f"file access failed: {exc}",
        }

    last_path, last_cursor = await _get_last_cursor(session, source.id)
    fast_forwarded = False

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

    backlog_bytes = max(0, file_size - start_offset)
    if backlog_bytes > _MAX_BACKLOG_BYTES_BEFORE_FAST_FORWARD:
        # Keep ingestion responsive by jumping close to EOF instead of replaying
        # tens of MB of old lines before fresh events appear in the UI.
        start_offset = max(0, file_size - _FAST_FORWARD_TAIL_BYTES)
        fast_forwarded = True

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

    try:
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
                    await _enqueue_event_index_outbox(session, _evt_batch)
                    _raw_batch.clear()
                    _evt_batch.clear()
    except PermissionError:
        return {
            "source_id": str(source.id),
            "path": (source.config_json or {}).get("path", ""),
            "skipped": True,
            "reason": f"no read permission for {path}; start the backend with access to this file",
        }
    except OSError as exc:
        return {
            "source_id": str(source.id),
            "path": (source.config_json or {}).get("path", ""),
            "skipped": True,
            "reason": f"file access failed: {exc}",
        }

    # Flush the final partial batch (< _BATCH_SIZE rows).
    if _raw_batch:
        await session.execute(insert(RawLog), _raw_batch)
        await session.execute(insert(Event), _evt_batch)
        await _enqueue_event_index_outbox(session, _evt_batch)

    return {
        "source_id": str(source.id),
        "path": (source.config_json or {}).get("path", ""),
        "lines_ingested": lines_ingested,
        "events_created": events_created,
        "start_offset": start_offset,
        "end_offset": new_cursor,
        "fast_forwarded": fast_forwarded,
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
