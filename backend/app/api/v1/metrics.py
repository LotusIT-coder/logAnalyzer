"""Metrics endpoints – timeseries, top-errors, top-services, error-rate."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import json
from ipaddress import ip_address
import re
import socket
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, Query
import httpx
from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.source_filters import resolve_source_ids
from app.auth import require_scope
from app.dependencies import get_db
from app.domain.models import Event
from app.schemas.domain import (
    ErrorRateResponse,
    NetworkGeoPoint,
    NetworkMapEdge,
    NetworkMapNode,
    NetworkMapResponse,
    TimeseriesPoint,
    TimeseriesResponse,
    TopErrorItem,
    TopErrorsResponse,
    TopServiceItem,
    TopServicesResponse,
)

router = APIRouter(prefix="/metrics", tags=["Metrics"])

_read = Depends(require_scope("read"))

_BUCKET_INTERVALS = {
    "1m": "1 minute",
    "5m": "5 minutes",
    "15m": "15 minutes",
    "1h": "1 hour",
}

_MAC_ADDRESS_RE = re.compile(r"(?i)(?:[0-9a-f]{2}:){5}[0-9a-f]{2}")
_LOCAL_MAC_RE = re.compile(r"(?i)local address=(?P<local>(?:[0-9a-f]{2}:){5}[0-9a-f]{2})")
_DHCP_LEASE_ADDRESS_RE = re.compile(r"(?i)dhcp[46][^\n]*address=(?P<address>[^,\s)]+)")
_NETWORK_MESSAGE_HINTS = (
    "%authenticate with%",
    "%associate with%",
    "%disconnect from AP%",
    "%RX AssocResp%",
    "%RX ReassocResp%",
    "%Group rekeying completed%",
    "%local address=%",
    '%"ip":%',
    '%"client_ip":%',
    '%"remote_ip":%',
    '%"host":%',
    "%dhcp4%",
    "%dhcp6%",
)
_NETWORK_EVENT_SCAN_LIMIT = 5000
_NETWORK_DEFAULT_LOOKBACK = timedelta(hours=24)
_GEO_LOOKUP_TIMEOUT = 2.0
_GEO_CACHE_TTL = timedelta(hours=12)
_GEO_FAILURE_TTL = timedelta(minutes=15)
_GEO_CACHE: dict[str, tuple[datetime, dict | None]] = {}


def _default_range() -> tuple[datetime, datetime]:
    """Wide default so 'all time' queries work without explicit from/to."""
    now = datetime.now(timezone.utc)
    return now - timedelta(days=3650), now


def _network_map_range(from_: Optional[datetime], to: Optional[datetime]) -> tuple[datetime, datetime]:
        now = datetime.now(timezone.utc)
        if from_ is None and to is None:
            return now - _NETWORK_DEFAULT_LOOKBACK, now
        if from_ is None and to is not None:
            return to - _NETWORK_DEFAULT_LOOKBACK, to
        return from_ or _default_range()[0], to or now


def _coerce_int(value: object) -> int:
    if value is None:
        return 0
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return 0


def _coerce_float(value: object) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def _coerce_fields_dict(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def _coerce_network_text(value: object) -> Optional[str]:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        normalized = value.strip()
        return normalized or None
    if isinstance(value, (int, float)):
        return str(value)
    return None


def _is_public_ip(candidate) -> bool:
    return not (
        candidate.is_private
        or candidate.is_loopback
        or candidate.is_link_local
        or candidate.is_multicast
        or candidate.is_reserved
        or candidate.is_unspecified
    )


def _network_ip_candidate(fields: dict, prefix: str) -> Optional[str]:
    raw_value = fields.get(f"{prefix}_ip")
    normalized = _normalize_network_label(raw_value)
    if not normalized:
        return None

    try:
        candidate = ip_address(normalized)
    except ValueError:
        return None

    if getattr(candidate, "ipv4_mapped", None):
        candidate = candidate.ipv4_mapped

    return str(candidate) if _is_public_ip(candidate) else None


async def _resolve_public_geo_target(value: str) -> Optional[str]:
    normalized = _normalize_network_label(value)
    if not normalized:
        return None

    try:
        candidate = ip_address(normalized)
    except ValueError:
        candidate = None

    if candidate is not None:
        if getattr(candidate, "ipv4_mapped", None):
            candidate = candidate.ipv4_mapped
        return str(candidate) if _is_public_ip(candidate) else None

    if "." not in normalized or " " in normalized:
        return None

    try:
        infos = await asyncio.wait_for(
            asyncio.get_running_loop().getaddrinfo(
                normalized,
                None,
                proto=socket.IPPROTO_TCP,
            ),
            timeout=_GEO_LOOKUP_TIMEOUT,
        )
    except (asyncio.TimeoutError, OSError, socket.gaierror):
        return None

    for family, _, _, _, sockaddr in infos:
        if family not in {socket.AF_INET, socket.AF_INET6}:
            continue

        ip_value = sockaddr[0]
        try:
            resolved = ip_address(ip_value)
        except ValueError:
            continue

        if getattr(resolved, "ipv4_mapped", None):
            resolved = resolved.ipv4_mapped

        if _is_public_ip(resolved):
            return str(resolved)

    return None


async def _lookup_geo_point(candidate: str, client: httpx.AsyncClient) -> Optional[dict]:
    resolved_ip = await _resolve_public_geo_target(candidate)
    if not resolved_ip:
        return None

    now = datetime.now(timezone.utc)
    cached = _GEO_CACHE.get(resolved_ip)
    if cached and cached[0] > now:
        return cached[1]

    try:
        response = await client.get(f"https://ipwho.is/{resolved_ip}")
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError):
        _GEO_CACHE[resolved_ip] = (now + _GEO_FAILURE_TTL, None)
        return None

    latitude = _coerce_float(payload.get("latitude"))
    longitude = _coerce_float(payload.get("longitude"))
    if not payload.get("success") or latitude is None or longitude is None:
        _GEO_CACHE[resolved_ip] = (now + _GEO_FAILURE_TTL, None)
        return None

    point = {
        "resolved_ip": resolved_ip,
        "latitude": latitude,
        "longitude": longitude,
        "city": payload.get("city"),
        "region": payload.get("region"),
        "country": payload.get("country"),
        "country_code": payload.get("country_code"),
        "source": "ipwho.is",
    }
    _GEO_CACHE[resolved_ip] = (now + _GEO_CACHE_TTL, point)
    return point


async def _lookup_geo_points(candidates_by_label: dict[str, str]) -> dict[str, dict]:
    labels = {label: candidate for label, candidate in candidates_by_label.items() if candidate}
    if not labels:
        return {}

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(_GEO_LOOKUP_TIMEOUT),
        headers={"User-Agent": "LotusAnalyzer/0.1"},
    ) as client:
        results = await asyncio.gather(
            *[_lookup_geo_point(candidate, client) for candidate in labels.values()],
            return_exceptions=True,
        )

    resolved: dict[str, dict] = {}
    for (label, _candidate), result in zip(labels.items(), results, strict=False):
        if isinstance(result, Exception) or not result:
            continue
        resolved[label] = result
    return resolved
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return 0


def _network_label(fields: dict, prefix: str) -> Optional[str]:
    for key in (f"{prefix}_host", f"{prefix}_ip"):
        value = fields.get(key)
        if isinstance(value, str) and value.strip():
            return _normalize_network_label(value)
    return None


def _normalize_network_label(value: object) -> Optional[str]:
    if not isinstance(value, str):
        return None

    label = value.strip()
    if not label or label == "?":
        return None

    if "://" in label:
        parsed = urlparse(label)
        label = parsed.hostname or label

    try:
        candidate = ip_address(label)
        if getattr(candidate, "ipv4_mapped", None):
            return str(candidate.ipv4_mapped)
        return str(candidate)
    except ValueError:
        return label


def _message_network_labels(event: Event) -> tuple[Optional[str], Optional[str]]:
    message = event.message or ""
    if not message:
        return None, None

    local_match = _LOCAL_MAC_RE.search(message)
    local_mac = local_match.group("local").lower() if local_match else None
    remote_macs = [match.group(0).lower() for match in _MAC_ADDRESS_RE.finditer(message) if match.group(0).lower() != local_mac]
    if not remote_macs:
        return None, None

    src_label = _normalize_network_label(event.host) or local_mac
    dst_label = remote_macs[-1]
    if not src_label or src_label == dst_label:
        return None, None
    return src_label, dst_label


def _message_json_payload(message: str) -> Optional[dict]:
    start = message.find("{")
    end = message.rfind("}")
    if start == -1 or end <= start:
        return None

    try:
        payload = json.loads(message[start:end + 1])
    except json.JSONDecodeError:
        return None

    return payload if isinstance(payload, dict) else None


def _json_message_network_edge(event: Event) -> tuple[Optional[str], Optional[str], Optional[str]]:
    payload = _message_json_payload(event.message or "")
    if not payload:
        return None, None, None

    request_payload = payload.get("request")
    if isinstance(request_payload, dict):
        src_label = _normalize_network_label(request_payload.get("client_ip") or request_payload.get("remote_ip"))
        dst_label = _normalize_network_label(request_payload.get("host"))
        proto = request_payload.get("proto")
        protocol = proto.split("/", 1)[0].lower() if isinstance(proto, str) and proto else None
        if src_label and dst_label and src_label != dst_label:
            return src_label, dst_label, protocol

    src_label = _normalize_network_label(event.host) or _normalize_network_label(payload.get("nodeId"))
    dst_label = _normalize_network_label(payload.get("ip"))
    protocol = "ws" if "[ws]" in (event.message or "").lower() else None
    if src_label and dst_label and src_label != dst_label:
        return src_label, dst_label, protocol

    return None, None, None


def _dhcp_message_network_edge(event: Event) -> tuple[Optional[str], Optional[str], Optional[str]]:
    message = event.message or ""
    if not message:
        return None, None, None

    match = _DHCP_LEASE_ADDRESS_RE.search(message)
    if not match:
        return None, None, None

    src_label = _normalize_network_label(event.host)
    dst_label = _normalize_network_label(match.group("address"))
    if src_label and dst_label and src_label != dst_label:
        return src_label, dst_label, "dhcp"
    return None, None, None


def _node_kind(label: str) -> str:
    try:
        candidate = ip_address(label)
        return "host" if candidate.is_private or candidate.is_loopback else "external"
    except ValueError:
        return "external" if "." in label and " " not in label else "host"


@router.get("/timeseries", response_model=TimeseriesResponse)
async def timeseries(
    _token=_read,
    session: AsyncSession = Depends(get_db),
    from_: Optional[datetime] = Query(None, alias="from"),
    to: Optional[datetime] = Query(None),
    bucket: str = Query("5m", pattern="^(1m|5m|15m|1h)$"),
    source_ids: Optional[str] = Query(None),
    source_paths: Optional[str] = Query(None),
):
    from_dt, to_dt = from_ or _default_range()[0], to or _default_range()[1]
    resolved_source_ids = await resolve_source_ids(session, source_ids_csv=source_ids, source_paths_csv=source_paths)
    if resolved_source_ids == []:
        return TimeseriesResponse(points=[])

    # Fetch raw timestamps — bucket in Python for DB portability (SQLite + PostgreSQL).
    stmt = (
        select(Event.timestamp)
        .where(Event.timestamp >= from_dt, Event.timestamp <= to_dt)
        .order_by(Event.timestamp)
    )
    if resolved_source_ids is not None:
        stmt = stmt.where(Event.source_id.in_(resolved_source_ids))

    result = await session.execute(stmt)
    timestamps = [row[0] for row in result.all()]

    bucket_minutes = {"1m": 1, "5m": 5, "15m": 15, "1h": 60}.get(bucket, 5)
    merged: dict[datetime, int] = {}
    for ts in timestamps:
        # Ensure timezone-aware for consistent bucketing
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        minutes = (ts.minute // bucket_minutes) * bucket_minutes
        bucket_ts = ts.replace(minute=minutes, second=0, microsecond=0)
        merged[bucket_ts] = merged.get(bucket_ts, 0) + 1

    points = [TimeseriesPoint(ts=ts, count=cnt) for ts, cnt in sorted(merged.items())]
    return TimeseriesResponse(points=points)


@router.get("/top-errors", response_model=TopErrorsResponse)
async def top_errors(
    _token=_read,
    session: AsyncSession = Depends(get_db),
    from_: Optional[datetime] = Query(None, alias="from"),
    to: Optional[datetime] = Query(None),
    source_ids: Optional[str] = Query(None),
    source_paths: Optional[str] = Query(None),
):
    from_dt, to_dt = from_ or _default_range()[0], to or _default_range()[1]
    resolved_source_ids = await resolve_source_ids(session, source_ids_csv=source_ids, source_paths_csv=source_paths)
    if resolved_source_ids == []:
        return TopErrorsResponse(items=[])

    stmt = (
        select(Event.message, func.count().label("count"))
        .where(
            Event.timestamp >= from_dt,
            Event.timestamp <= to_dt,
            Event.severity.in_(["error", "critical"]),
        )
        .group_by(Event.message)
        .order_by(text("count DESC"))
        .limit(20)
    )
    if resolved_source_ids is not None:
        stmt = stmt.where(Event.source_id.in_(resolved_source_ids))

    result = await session.execute(stmt)
    items = [TopErrorItem(key=row.message, count=row.count) for row in result]
    return TopErrorsResponse(items=items)


@router.get("/top-services", response_model=TopServicesResponse)
async def top_services(
    _token=_read,
    session: AsyncSession = Depends(get_db),
    from_: Optional[datetime] = Query(None, alias="from"),
    to: Optional[datetime] = Query(None),
    source_ids: Optional[str] = Query(None),
    source_paths: Optional[str] = Query(None),
):
    from_dt, to_dt = from_ or _default_range()[0], to or _default_range()[1]
    resolved_source_ids = await resolve_source_ids(session, source_ids_csv=source_ids, source_paths_csv=source_paths)
    if resolved_source_ids == []:
        return TopServicesResponse(items=[])

    stmt = (
        select(Event.service, func.count().label("count"))
        .where(
            Event.timestamp >= from_dt,
            Event.timestamp <= to_dt,
            Event.service.isnot(None),
        )
        .group_by(Event.service)
        .order_by(text("count DESC"))
        .limit(20)
    )
    if resolved_source_ids is not None:
        stmt = stmt.where(Event.source_id.in_(resolved_source_ids))

    result = await session.execute(stmt)
    items = [TopServiceItem(service=row.service, count=row.count) for row in result]
    return TopServicesResponse(items=items)


@router.get("/error-rate", response_model=ErrorRateResponse)
async def error_rate(
    _token=_read,
    session: AsyncSession = Depends(get_db),
    from_: Optional[datetime] = Query(None, alias="from"),
    to: Optional[datetime] = Query(None),
    source_ids: Optional[str] = Query(None),
    source_paths: Optional[str] = Query(None),
):
    from_dt, to_dt = from_ or _default_range()[0], to or _default_range()[1]
    resolved_source_ids = await resolve_source_ids(session, source_ids_csv=source_ids, source_paths_csv=source_paths)
    if resolved_source_ids == []:
        return ErrorRateResponse(total_events=0, error_events=0, error_rate=0.0)

    total_stmt = select(func.count()).where(Event.timestamp >= from_dt, Event.timestamp <= to_dt)
    if resolved_source_ids is not None:
        total_stmt = total_stmt.where(Event.source_id.in_(resolved_source_ids))

    total_result = await session.execute(total_stmt)
    total = total_result.scalar_one() or 0

    error_stmt = select(func.count()).where(
        Event.timestamp >= from_dt,
        Event.timestamp <= to_dt,
        Event.severity.in_(["error", "critical"]),
    )
    if resolved_source_ids is not None:
        error_stmt = error_stmt.where(Event.source_id.in_(resolved_source_ids))

    error_result = await session.execute(error_stmt)
    errors = error_result.scalar_one() or 0

    rate = round(errors / total, 4) if total > 0 else 0.0
    return ErrorRateResponse(total_events=total, error_events=errors, error_rate=rate)


@router.get("/network/map", response_model=NetworkMapResponse)
async def network_map(
    _token=_read,
    session: AsyncSession = Depends(get_db),
    from_: Optional[datetime] = Query(None, alias="from"),
    to: Optional[datetime] = Query(None),
    source_ids: Optional[str] = Query(None),
    source_paths: Optional[str] = Query(None),
):
    from_dt, to_dt = _network_map_range(from_, to)
    resolved_source_ids = await resolve_source_ids(session, source_ids_csv=source_ids, source_paths_csv=source_paths)
    if resolved_source_ids == []:
        return NetworkMapResponse(nodes=[], edges=[])

    stmt = (
        select(Event)
        .where(Event.timestamp >= from_dt, Event.timestamp <= to_dt)
        .where(
            or_(
                Event.event_type == "network_flow",
                *[Event.message.ilike(pattern) for pattern in _NETWORK_MESSAGE_HINTS],
            )
        )
        .order_by(Event.timestamp.desc())
        .limit(_NETWORK_EVENT_SCAN_LIMIT)
    )
    if resolved_source_ids is not None:
        stmt = stmt.where(Event.source_id.in_(resolved_source_ids))

    result = await session.execute(stmt)
    events = result.scalars().all()

    edge_totals: dict[tuple, dict] = {}
    node_totals: dict[str, dict] = {}
    geo_candidates_by_label: dict[str, str] = {}

    for event in events:
        fields = _coerce_fields_dict(event.fields_json)
        src_label = _network_label(fields, "src")
        dst_label = _network_label(fields, "dst")
        protocol = _coerce_network_text(fields.get("protocol"))

        if not src_label or not dst_label:
            src_label, dst_label = _message_network_labels(event)
            if (src_label and dst_label) and not protocol:
                protocol = "wifi"

        if not src_label or not dst_label:
            src_label, dst_label, inferred_protocol = _json_message_network_edge(event)
            if (src_label and dst_label) and inferred_protocol and not protocol:
                protocol = inferred_protocol

        if not src_label or not dst_label:
            src_label, dst_label, inferred_protocol = _dhcp_message_network_edge(event)
            if (src_label and dst_label) and inferred_protocol and not protocol:
                protocol = inferred_protocol

        if not src_label or not dst_label:
            continue

        app = _coerce_network_text(fields.get("app")) or _coerce_network_text(event.service)
        dst_port_value = fields.get("dst_port")
        dst_port = _coerce_int(dst_port_value) if dst_port_value is not None else None
        src_geo_candidate = _network_ip_candidate(fields, "src")
        dst_geo_candidate = _network_ip_candidate(fields, "dst")
        bytes_total = sum(
            _coerce_int(fields.get(key))
            for key in ("bytes", "bytes_total", "bytes_in", "bytes_out")
        )
        action = (_coerce_network_text(fields.get("action")) or "").lower()
        allowed = 1 if action in {"allow", "allowed", "accept", "accepted", "pass"} else 0
        blocked = 1 if action in {"deny", "denied", "drop", "dropped", "block", "blocked", "reject", "reset"} else 0

        edge_key = (src_label, dst_label, app, protocol, dst_port)
        edge_entry = edge_totals.setdefault(
            edge_key,
            {
                "source": src_label,
                "target": dst_label,
                "app": app,
                "protocol": protocol,
                "dst_port": dst_port,
                "bytes": 0,
                "connections": 0,
                "allowed_count": 0,
                "blocked_count": 0,
                "anomaly_score": 0.0,
            },
        )
        edge_entry["bytes"] += bytes_total
        edge_entry["connections"] += 1
        edge_entry["allowed_count"] += allowed
        edge_entry["blocked_count"] += blocked

        for label, geo_candidate in ((src_label, src_geo_candidate), (dst_label, dst_geo_candidate)):
            node_entry = node_totals.setdefault(
                label,
                {
                    "id": label,
                    "label": label,
                    "kind": _node_kind(label),
                    "total_bytes": 0,
                    "total_connections": 0,
                    "risk_score": 0.0,
                },
            )
            node_entry["total_bytes"] += bytes_total
            node_entry["total_connections"] += 1
            if blocked:
                node_entry["risk_score"] += 1.0
            if geo_candidate and label not in geo_candidates_by_label:
                geo_candidates_by_label[label] = geo_candidate

    geo_points = await _lookup_geo_points({
        label: geo_candidates_by_label.get(label) or label
        for label, node in node_totals.items()
        if geo_candidates_by_label.get(label) or node["kind"] == "external"
    })
    for label, geo_point in geo_points.items():
        node_totals[label]["geo"] = NetworkGeoPoint(**geo_point)

    nodes = [NetworkMapNode(**node_totals[key]) for key in sorted(node_totals)]
    edges = [
        NetworkMapEdge(**edge_totals[key])
        for key in sorted(edge_totals, key=lambda value: (value[0], value[1], value[2] or "", value[3] or "", value[4] or 0))
    ]
    return NetworkMapResponse(nodes=nodes, edges=edges)
