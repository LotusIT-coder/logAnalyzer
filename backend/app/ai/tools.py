"""Tool definitions for the SOC analyst chat.

The LLM is given a small toolbox to query log events on its own. Every tool
is described as a JSON schema (Ollama / OpenAI compatible) and paired with an
async executor that runs the actual SQL query against the active session.

The executors return JSON-serialisable dicts with a compact, model-friendly
shape. Long event lists are truncated to keep the context window healthy.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from sqlalchemy import desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.models import Event, Incident, Source

# ---------------------------------------------------------------------------
# Tool schemas (Ollama / OpenAI compatible)
# ---------------------------------------------------------------------------

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "search_logs",
            "description": (
                "Free-text search across log event messages. Use this to find "
                "events containing specific words, error codes, IPs, hostnames, "
                "user names or any other substring."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Substring to search for in the event message (case insensitive).",
                    },
                    "severity": {
                        "type": "string",
                        "description": "Optional severity filter: debug, info, warning, error, critical. Comma separated for multiple.",
                    },
                    "source_id": {
                        "type": "string",
                        "description": "Optional source id (UUID) to limit the search to one source.",
                    },
                    "hours_back": {
                        "type": "number",
                        "description": "Limit search to the last N hours (default: respect user filter).",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of events to return (default 25, max 100).",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_recent_logs",
            "description": (
                "Return the most recent log events, optionally filtered by "
                "severity / source. Use this to get a fresh snapshot of what "
                "happened lately when the user asks vague questions like "
                "\"was ist los?\" or \"alles ok?\"."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "severity": {
                        "type": "string",
                        "description": "Optional severity filter (comma separated).",
                    },
                    "source_id": {
                        "type": "string",
                        "description": "Optional source id (UUID).",
                    },
                    "hours_back": {
                        "type": "number",
                        "description": "Time window in hours (default: respect user filter).",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of events (default 25, max 100).",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_log_stats",
            "description": (
                "Aggregate statistics over events: counts per severity, per "
                "service and per host. Use this to get a quick overview before "
                "drilling down."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "source_id": {"type": "string", "description": "Optional source id."},
                    "hours_back": {
                        "type": "number",
                        "description": "Time window in hours (default: respect user filter).",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_top_errors",
            "description": (
                "Return the most frequent error / critical event messages "
                "(grouped by message)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "source_id": {"type": "string"},
                    "hours_back": {"type": "number"},
                    "limit": {"type": "integer", "description": "Default 10, max 50."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_sources",
            "description": "List all configured log sources (id, name, type, path).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_incidents",
            "description": (
                "Return the latest open incidents (rule- or AI-triaged). Use "
                "this when the user asks about incidents, alerts or open issues."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "description": "Optional status filter (open, acknowledged, resolved, archived).",
                    },
                    "limit": {"type": "integer", "description": "Default 20, max 100."},
                },
            },
        },
    },
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _split_severity(value: str | None) -> list[str]:
    if not value:
        return []
    return [v.strip().lower() for v in str(value).split(",") if v.strip()]


def _resolve_hours(hours_back: float | int | None, default_hours: float | None) -> float | None:
    if hours_back is not None:
        try:
            h = float(hours_back)
            return h if h > 0 else None
        except (TypeError, ValueError):
            pass
    return default_hours


def _format_event(event: Event) -> dict[str, Any]:
    return {
        "id": event.id,
        "timestamp": event.timestamp.isoformat(),
        "severity": event.severity,
        "host": event.host,
        "service": event.service,
        "message": event.message,
        "source_id": event.source_id,
    }


def _format_event_line(event: Event) -> str:
    ts = event.timestamp.strftime("%Y-%m-%d %H:%M:%S")
    host = f" {event.host}" if event.host else ""
    svc = f" {event.service}" if event.service else ""
    return f"[{ts}] [{event.severity.upper()}]{host}{svc} {event.message}"


def _severity_rank(value: str | None) -> int:
    sev = (value or "").lower()
    if sev == "critical":
        return 5
    if sev == "error":
        return 4
    if sev == "warning":
        return 3
    if sev == "info":
        return 2
    if sev == "debug":
        return 1
    return 0


# ---------------------------------------------------------------------------
# Tool context bundles a session + the user's pre-selected scope so every
# tool call respects the dashboard filter unless the LLM overrides it.
# ---------------------------------------------------------------------------


class ToolContext:
    def __init__(
        self,
        session: AsyncSession,
        default_source_ids: list[str],
        default_source_paths: list[str],
        default_hours: float | None,
    ) -> None:
        self.session = session
        self.default_source_ids = default_source_ids or []
        self.default_source_paths = default_source_paths or []
        self.default_hours = default_hours
        self.collected_events: list[Event] = []

    async def _resolve_path_source_ids(self) -> list[str]:
        """Translate the user's source_paths filter into source ids."""
        if not self.default_source_paths:
            return []
        sub = await self.session.execute(
            select(Source.id).where(
                or_(*[Source.config_json["path"].astext == p for p in self.default_source_paths])
            )
        )
        return [row[0] for row in sub.all()]

    async def effective_source_ids(self, override: str | None) -> list[str]:
        """Combine an explicit override with the user's pre-selected scope."""
        if override:
            return [override]
        ids = list(self.default_source_ids)
        ids.extend(await self._resolve_path_source_ids())
        return ids


# ---------------------------------------------------------------------------
# Tool executors
# ---------------------------------------------------------------------------


async def _tool_search_logs(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "query is required"}

    limit = max(1, min(int(args.get("limit") or 25), 100))
    severities = _split_severity(args.get("severity"))
    hours = _resolve_hours(args.get("hours_back"), ctx.default_hours)
    source_ids = await ctx.effective_source_ids(args.get("source_id"))

    stmt = select(Event).where(Event.message.ilike(f"%{query}%"))
    if severities:
        stmt = stmt.where(Event.severity.in_(severities))
    if source_ids:
        stmt = stmt.where(Event.source_id.in_(source_ids))
    if hours:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        stmt = stmt.where(Event.timestamp >= cutoff)
    stmt = stmt.order_by(desc(Event.timestamp)).limit(limit)

    result = await ctx.session.execute(stmt)
    events = result.scalars().all()
    ctx.collected_events.extend(events)
    return {
        "query": query,
        "count": len(events),
        "events": [_format_event(e) for e in events],
    }


async def _tool_get_recent_logs(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    limit = max(1, min(int(args.get("limit") or 25), 100))
    severities = _split_severity(args.get("severity"))
    hours = _resolve_hours(args.get("hours_back"), ctx.default_hours)
    source_ids = await ctx.effective_source_ids(args.get("source_id"))

    stmt = select(Event)
    if severities:
        stmt = stmt.where(Event.severity.in_(severities))
    if source_ids:
        stmt = stmt.where(Event.source_id.in_(source_ids))
    if hours:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        stmt = stmt.where(Event.timestamp >= cutoff)
    stmt = stmt.order_by(desc(Event.timestamp)).limit(limit)

    result = await ctx.session.execute(stmt)
    events = result.scalars().all()
    ctx.collected_events.extend(events)
    return {
        "count": len(events),
        "events": [_format_event(e) for e in events],
    }


async def _tool_get_log_stats(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    hours = _resolve_hours(args.get("hours_back"), ctx.default_hours)
    source_ids = await ctx.effective_source_ids(args.get("source_id"))

    base_filters = []
    if source_ids:
        base_filters.append(Event.source_id.in_(source_ids))
    if hours:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        base_filters.append(Event.timestamp >= cutoff)

    async def _grouped(col):
        stmt = select(col, func.count()).group_by(col).order_by(desc(func.count())).limit(15)
        for f in base_filters:
            stmt = stmt.where(f)
        rows = (await ctx.session.execute(stmt)).all()
        return [{"key": r[0], "count": r[1]} for r in rows if r[0] is not None]

    total_stmt = select(func.count()).select_from(Event)
    for f in base_filters:
        total_stmt = total_stmt.where(f)
    total = (await ctx.session.execute(total_stmt)).scalar_one()

    return {
        "total_events": int(total or 0),
        "hours_back": hours,
        "by_severity": await _grouped(Event.severity),
        "by_service": await _grouped(Event.service),
        "by_host": await _grouped(Event.host),
    }


async def _tool_get_top_errors(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    limit = max(1, min(int(args.get("limit") or 10), 50))
    hours = _resolve_hours(args.get("hours_back"), ctx.default_hours)
    source_ids = await ctx.effective_source_ids(args.get("source_id"))

    stmt = (
        select(Event.message, func.count().label("c"))
        .where(Event.severity.in_(["error", "critical"]))
        .group_by(Event.message)
        .order_by(desc("c"))
        .limit(limit)
    )
    if source_ids:
        stmt = stmt.where(Event.source_id.in_(source_ids))
    if hours:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        stmt = stmt.where(Event.timestamp >= cutoff)

    rows = (await ctx.session.execute(stmt)).all()
    return {
        "count": len(rows),
        "items": [{"message": r[0], "count": r[1]} for r in rows],
    }


async def _tool_list_sources(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    rows = (await ctx.session.execute(select(Source))).scalars().all()
    return {
        "count": len(rows),
        "sources": [
            {
                "id": s.id,
                "name": s.name,
                "type": s.type,
                "enabled": s.enabled,
                "path": (s.config_json or {}).get("path"),
            }
            for s in rows
        ],
    }


async def _tool_get_incidents(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    limit = max(1, min(int(args.get("limit") or 20), 100))
    status_filter = (args.get("status") or "").strip().lower()

    stmt = select(Incident).order_by(desc(Incident.last_seen)).limit(limit)
    if status_filter:
        stmt = stmt.where(Incident.status == status_filter)

    rows = (await ctx.session.execute(stmt)).scalars().all()
    return {
        "count": len(rows),
        "incidents": [
            {
                "id": i.id,
                "title": i.title,
                "status": i.status,
                "severity": i.severity,
                "first_seen": i.first_seen.isoformat(),
                "last_seen": i.last_seen.isoformat(),
                "event_count": i.event_count,
                "summary": i.summary,
            }
            for i in rows
        ],
    }


TOOL_REGISTRY: dict[str, Callable[[ToolContext, dict[str, Any]], Awaitable[dict[str, Any]]]] = {
    "search_logs": _tool_search_logs,
    "get_recent_logs": _tool_get_recent_logs,
    "get_log_stats": _tool_get_log_stats,
    "get_top_errors": _tool_get_top_errors,
    "list_sources": _tool_list_sources,
    "get_incidents": _tool_get_incidents,
}


def collect_references(ctx: ToolContext, limit: int = 25) -> list[str]:
    """Deduplicate and format collected events for the UI references panel.

    References are sorted by severity first (critical/error before warning/info)
    and then by recency. This keeps the evidence panel focused on actionable
    signals instead of mostly informational noise.
    """
    seen: set[str] = set()
    out: list[str] = []
    ordered = sorted(
        ctx.collected_events,
        key=lambda e: (_severity_rank(e.severity), e.timestamp),
        reverse=True,
    )
    for event in ordered:
        if event.id in seen:
            continue
        seen.add(event.id)
        out.append(_format_event_line(event))
        if len(out) >= limit:
            break
    return out
