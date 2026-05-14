from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_STATE_PATH = Path(__file__).resolve().parents[2] / "data" / "runtime" / "soc_analyst_state.json"


def load_soc_analyst_runtime_state(default_enabled: bool) -> dict[str, Any]:
    state: dict[str, Any] = {
        "enabled": bool(default_enabled),
        "source_ids": [],
    }
    if not _STATE_PATH.exists():
        return state

    try:
        raw = json.loads(_STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return state

    if isinstance(raw, dict):
        if "enabled" in raw:
            state["enabled"] = bool(raw.get("enabled"))
        src_ids = raw.get("source_ids")
        if isinstance(src_ids, list):
            state["source_ids"] = [str(item) for item in src_ids if str(item).strip()]
    return state


def save_soc_analyst_runtime_state(enabled: bool, source_ids: list[str] | None = None) -> None:
    payload = {
        "enabled": bool(enabled),
        "source_ids": list(dict.fromkeys(source_ids or [])),
    }
    _STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _STATE_PATH.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")
