"""Parser pipeline: JSON, regex, key-value, and grok-compatible patterns.

Each parser attempts to extract a canonical dict from a raw log line.
The pipeline tries parsers in priority order (lowest number = highest priority).

Canonical dict keys (all optional except 'message'):
  timestamp, severity, service, host, environment, event_type, message, **extra_fields
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, Optional


# ---------------------------------------------------------------------------
# Grok-compatible pattern aliases
# ---------------------------------------------------------------------------
_GROK_ALIASES: Dict[str, str] = {
    "TIMESTAMP_ISO8601": r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?",
    "LOGLEVEL": r"(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|CRITICAL|FATAL)",
    "GREEDYDATA": r".*",
    "DATA": r".*?",
    "WORD": r"\b\w+\b",
    "NUMBER": r"\d+(?:\.\d+)?",
    "IP": r"\d{1,3}(?:\.\d{1,3}){3}",
    "HOSTNAME": r"\S+",
    "NOTSPACE": r"\S+",
    "SPACE": r"\s+",
    "QUOTEDSTRING": r'"[^"]*"',
}


def _expand_grok(pattern: str) -> str:
    """Replace %{ALIAS:name} or %{ALIAS} with regex named groups."""
    def replacer(m: re.Match) -> str:
        alias = m.group(1)
        name = m.group(2)
        regex = _GROK_ALIASES.get(alias, r".*?")
        if name:
            return f"(?P<{name}>{regex})"
        return f"(?:{regex})"

    return re.sub(r"%\{(\w+)(?::(\w+))?\}", replacer, pattern)


# ---------------------------------------------------------------------------
# Individual parsers
# ---------------------------------------------------------------------------

def _parse_json(line: str, _mapping: Dict[str, str]) -> Optional[Dict[str, Any]]:
    """Try to parse the line as JSON. Applies field-name mapping."""
    stripped = line.strip()
    if not stripped.startswith("{"):
        return None
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    return _apply_mapping(data, _mapping)


def _parse_regex(line: str, pattern: str, mapping: Dict[str, str]) -> Optional[Dict[str, Any]]:
    """Try to match line against a regex with named groups."""
    try:
        m = re.search(pattern, line)
    except re.error:
        return None
    if not m:
        return None
    return _apply_mapping(m.groupdict(), mapping)


def _parse_grok(line: str, pattern: str, mapping: Dict[str, str]) -> Optional[Dict[str, Any]]:
    """Expand grok aliases, then delegate to regex parser."""
    try:
        expanded = _expand_grok(pattern)
    except Exception:
        return None
    return _parse_regex(line, expanded, mapping)


def _parse_kv(line: str, mapping: Dict[str, str]) -> Optional[Dict[str, Any]]:
    """Parse key=value (or key="value") pairs from a line."""
    pairs = re.findall(r'(\w+)=(?:"([^"]*)"|([\S]*))', line)
    if not pairs:
        return None
    data: Dict[str, Any] = {}
    for key, quoted, unquoted in pairs:
        data[key] = quoted if quoted else unquoted
    if not data:
        return None
    return _apply_mapping(data, mapping)


# ---------------------------------------------------------------------------
# Field mapping + normalization
# ---------------------------------------------------------------------------

_CANONICAL_FIELDS = {"timestamp", "severity", "service", "host", "environment", "event_type", "message"}
_SEVERITY_ALIASES: Dict[str, str] = {
    "warn": "warning",
    "warning": "warning",
    "err": "error",
    "crit": "critical",
    "fatal": "critical",
    "trace": "debug",
}


def _apply_mapping(raw: Dict[str, Any], mapping: Dict[str, str]) -> Dict[str, Any]:
    """Rename fields according to mapping_json, keep unmapped fields in extra."""
    result: Dict[str, Any] = dict(raw)
    for src_field, dest_field in mapping.items():
        if src_field in result:
            result[dest_field] = result.pop(src_field)
    return result


def _normalize(data: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize severity, ensure 'message' is present, split canonical vs extra."""
    sev = str(data.get("severity", "info")).lower()
    data["severity"] = _SEVERITY_ALIASES.get(sev, sev)

    if "message" not in data or not data["message"]:
        # Fallback: use 'msg' or 'log' keys
        data["message"] = str(data.pop("msg", data.pop("log", "")))

    return data


# ---------------------------------------------------------------------------
# Public pipeline entry
# ---------------------------------------------------------------------------

def parse_line(
    line: str,
    fmt: str,
    pattern: Optional[str],
    mapping: Optional[Dict[str, str]],
) -> Optional[Dict[str, Any]]:
    """
    Attempt to parse *line* using the given parser profile settings.

    Returns a normalized dict on success, None if parsing fails.
    The caller is responsible for building the Event ORM row.
    """
    _mapping = mapping or {}

    if fmt == "json":
        result = _parse_json(line, _mapping)
    elif fmt == "regex":
        result = _parse_regex(line, pattern or "", _mapping) if pattern else None
    elif fmt == "grok":
        result = _parse_grok(line, pattern or "", _mapping) if pattern else None
    elif fmt == "kv":
        result = _parse_kv(line, _mapping)
    else:
        return None

    if result is None:
        return None

    return _normalize(result)
