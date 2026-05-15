"""Normalize ECS-like payloads into the internal canonical event shape."""
from __future__ import annotations

from typing import Any


def _is_populated(value: Any) -> bool:
    return value is not None and value != ""


def _get_nested_value(payload: dict[str, Any], dotted_key: str) -> Any:
    direct = payload.get(dotted_key)
    if _is_populated(direct):
        return direct

    current: Any = payload
    for part in dotted_key.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _set_if_missing(payload: dict[str, Any], key: str, value: Any) -> None:
    if not _is_populated(payload.get(key)) and _is_populated(value):
        payload[key] = value


def _coerce_text(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    return None


def normalize_ecs_payload(parsed: dict[str, Any], raw_line: str) -> dict[str, Any]:
    """Map common ECS fields to internal keys while keeping existing fields intact."""
    normalized = dict(parsed)

    _set_if_missing(normalized, "message", raw_line)

    host_value = normalized.get("host")
    if not isinstance(host_value, str) or not host_value:
        ecs_host = _coerce_text(_get_nested_value(normalized, "host.name"))
        if ecs_host:
            normalized["host"] = ecs_host

    event_code = _get_nested_value(normalized, "event.code")
    if not _is_populated(normalized.get("event_type")) and _is_populated(event_code):
        normalized["event_type"] = str(event_code)

    _set_if_missing(normalized, "username", _get_nested_value(normalized, "user.name"))
    _set_if_missing(normalized, "process_command_line", _get_nested_value(normalized, "process.command_line"))
    _set_if_missing(normalized, "source_ip", _get_nested_value(normalized, "source.ip"))

    return normalized
