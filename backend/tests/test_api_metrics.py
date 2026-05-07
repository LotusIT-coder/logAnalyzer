"""Tests for metrics API endpoints (Point 3: Dashboard echte Daten).

These tests verify that the metrics endpoints return real data from the DB,
and that the default behaviour (no source filter) returns aggregated totals.

The timeseries endpoint uses date_trunc (PostgreSQL). For SQLite we need
a fallback; the implementation must handle both gracefully.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1 import metrics as metrics_api
from app.domain.models import Event, Source


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_source(session: AsyncSession, *, name: str = "test-src") -> Source:
    s = Source(
        name=name,
        type="file",
        enabled=True,
        config_json={"path": f"/var/log/{name}.log"},
    )
    session.add(s)
    return s


def _make_event(
    session: AsyncSession,
    source: Source,
    *,
    severity: str = "info",
    message: str = "test message",
    service: str | None = "svc",
    event_type: str = "log",
    fields: dict | None = None,
    ts: datetime | None = None,
) -> Event:
    e = Event(
        source_id=source.id,
        timestamp=ts or datetime.now(timezone.utc),
        severity=severity,
        message=message,
        service=service,
        host="host1",
        environment="test",
        event_type=event_type,
        fields_json=fields or {},
        fingerprint="fp-" + message[:8].replace(" ", "-"),
    )
    session.add(e)
    return e


# ---------------------------------------------------------------------------
# /metrics/timeseries
# ---------------------------------------------------------------------------

class TestTimeseries:
    async def test_returns_200_with_no_events(self, client, db_session):
        resp = await client.get("/api/v1/metrics/timeseries")
        assert resp.status_code == 200
        data = resp.json()
        assert "points" in data
        assert isinstance(data["points"], list)

    async def test_returns_points_for_ingested_events(self, client, db_session):
        src = _make_source(db_session, name="metrics-src")
        db_session.add(src)
        await db_session.flush()
        _make_event(db_session, src, message="hello1")
        _make_event(db_session, src, message="hello2")
        await db_session.commit()

        resp = await client.get("/api/v1/metrics/timeseries")
        assert resp.status_code == 200
        data = resp.json()
        assert sum(p["count"] for p in data["points"]) >= 2

    async def test_source_filter_by_id_limits_results(self, client, db_session):
        src_a = _make_source(db_session, name="src-a")
        src_b = _make_source(db_session, name="src-b")
        db_session.add_all([src_a, src_b])
        await db_session.flush()
        _make_event(db_session, src_a, message="from-a")
        _make_event(db_session, src_b, message="from-b")
        await db_session.commit()

        resp = await client.get(f"/api/v1/metrics/timeseries?source_ids={src_a.id}")
        assert resp.status_code == 200
        total = sum(p["count"] for p in resp.json()["points"])
        assert total == 1  # only src_a's event


# ---------------------------------------------------------------------------
# /metrics/top-errors
# ---------------------------------------------------------------------------

class TestTopErrors:
    async def test_returns_200_with_no_events(self, client, db_session):
        resp = await client.get("/api/v1/metrics/top-errors")
        assert resp.status_code == 200
        assert resp.json()["items"] == []

    async def test_counts_error_and_critical_events(self, client, db_session):
        src = _make_source(db_session, name="top-err-src")
        db_session.add(src)
        await db_session.flush()
        _make_event(db_session, src, severity="error", message="connection refused")
        _make_event(db_session, src, severity="error", message="connection refused")
        _make_event(db_session, src, severity="critical", message="out of memory")
        _make_event(db_session, src, severity="info", message="all good")  # not counted
        await db_session.commit()

        resp = await client.get("/api/v1/metrics/top-errors")
        assert resp.status_code == 200
        items = resp.json()["items"]
        assert len(items) >= 2
        top = max(items, key=lambda x: x["count"])
        assert top["count"] == 2

    async def test_info_events_not_in_top_errors(self, client, db_session):
        src = _make_source(db_session, name="info-only-src")
        db_session.add(src)
        await db_session.flush()
        _make_event(db_session, src, severity="info", message="startup")
        await db_session.commit()

        resp = await client.get("/api/v1/metrics/top-errors")
        assert resp.json()["items"] == []


# ---------------------------------------------------------------------------
# /metrics/top-services
# ---------------------------------------------------------------------------

class TestTopServices:
    async def test_returns_200_with_no_events(self, client, db_session):
        resp = await client.get("/api/v1/metrics/top-services")
        assert resp.status_code == 200
        assert resp.json()["items"] == []

    async def test_counts_events_per_service(self, client, db_session):
        src = _make_source(db_session, name="svc-src")
        db_session.add(src)
        await db_session.flush()
        for _ in range(3):
            _make_event(db_session, src, service="nginx", message="req")
        _make_event(db_session, src, service="sshd", message="login")
        await db_session.commit()

        resp = await client.get("/api/v1/metrics/top-services")
        assert resp.status_code == 200
        items = {i["service"]: i["count"] for i in resp.json()["items"]}
        assert items["nginx"] == 3
        assert items["sshd"] == 1


# ---------------------------------------------------------------------------
# /metrics/error-rate
# ---------------------------------------------------------------------------

class TestErrorRate:
    async def test_returns_200_with_no_events(self, client, db_session):
        resp = await client.get("/api/v1/metrics/error-rate")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_events"] == 0
        assert data["error_rate"] == 0.0

    async def test_calculates_error_rate(self, client, db_session):
        src = _make_source(db_session, name="rate-src")
        db_session.add(src)
        await db_session.flush()
        _make_event(db_session, src, severity="info", message="ok")
        _make_event(db_session, src, severity="error", message="fail")
        _make_event(db_session, src, severity="critical", message="crash")
        _make_event(db_session, src, severity="warning", message="warn")
        await db_session.commit()

        resp = await client.get("/api/v1/metrics/error-rate")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_events"] == 4
        # error + critical = 2 out of 4 → 50%
        assert abs(data["error_rate"] - 0.5) < 0.01


# ---------------------------------------------------------------------------
# /metrics/network/map
# ---------------------------------------------------------------------------

class TestNetworkMap:
    async def test_returns_empty_graph_with_no_network_events(self, client, db_session):
        resp = await client.get("/api/v1/metrics/network/map")
        assert resp.status_code == 200
        data = resp.json()
        assert data == {"nodes": [], "edges": []}

    async def test_derives_wifi_edges_from_mac_messages(self, client, db_session):
        src = _make_source(db_session, name="wifi-src")
        db_session.add(src)
        await db_session.flush()

        _make_event(
            db_session,
            src,
            service="kernel",
            message="wlo1: authenticate with 48:5d:35:4f:3b:f2 (local address=a8:e2:91:47:31:82)",
        )
        _make_event(
            db_session,
            src,
            service="kernel",
            message="wlo1: associate with 48:5d:35:4f:3b:f2 (try 1/3)",
        )
        await db_session.commit()

        resp = await client.get("/api/v1/metrics/network/map")
        assert resp.status_code == 200
        data = resp.json()

        assert {node["label"] for node in data["nodes"]} == {"host1", "48:5d:35:4f:3b:f2"}
        assert len(data["edges"]) == 1
        edge = data["edges"][0]
        assert edge["source"] == "host1"
        assert edge["target"] == "48:5d:35:4f:3b:f2"
        assert edge["protocol"] == "wifi"
        assert edge["app"] == "kernel"
        assert edge["connections"] == 2

    async def test_derives_edges_from_embedded_json_messages(self, client, db_session):
        src = _make_source(db_session, name="json-src")
        db_session.add(src)
        await db_session.flush()

        _make_event(
            db_session,
            src,
            service="node",
            message='2026-05-03 14:04:12.977 info [ws] Verbindung geoeffnet {"nodeId":"node-1","ip":"::ffff:127.0.0.1","totalClients":1}',
        )
        _make_event(
            db_session,
            src,
            service="caddy",
            message='{"level":"error","request":{"client_ip":"127.0.0.1","proto":"HTTP/1.1","host":"lotusmessenger.duckdns.org"},"msg":"dial tcp 127.0.0.1:3000: connect: connection refused"}',
        )
        await db_session.commit()

        resp = await client.get("/api/v1/metrics/network/map")
        assert resp.status_code == 200
        data = resp.json()

        labels = {node["label"] for node in data["nodes"]}
        assert {"host1", "127.0.0.1", "lotusmessenger.duckdns.org"}.issubset(labels)

        edges = {(edge["source"], edge["target"]): edge for edge in data["edges"]}
        assert edges[("host1", "127.0.0.1")]["protocol"] == "ws"
        assert edges[("127.0.0.1", "lotusmessenger.duckdns.org")]["protocol"] == "http"
        assert edges[("127.0.0.1", "lotusmessenger.duckdns.org")]["app"] == "caddy"

    async def test_derives_dhcp_lease_edges_from_networkmanager_messages(self, client, db_session):
        src = _make_source(db_session, name="networkmanager-src")
        db_session.add(src)
        await db_session.flush()

        _make_event(
            db_session,
            src,
            service="NetworkManager",
            message="<info>  [1777821346.2645] dhcp4 (wlo1): state changed new lease, address=192.168.178.47",
        )
        await db_session.commit()

        resp = await client.get("/api/v1/metrics/network/map")
        assert resp.status_code == 200
        data = resp.json()

        assert {node["label"] for node in data["nodes"]} == {"host1", "192.168.178.47"}
        assert len(data["edges"]) == 1
        edge = data["edges"][0]
        assert edge["source"] == "host1"
        assert edge["target"] == "192.168.178.47"
        assert edge["protocol"] == "dhcp"
        assert edge["app"] == "NetworkManager"
        assert edge["connections"] == 1

    async def test_aggregates_network_flows_into_graph(self, client, db_session):
        src = _make_source(db_session, name="net-src")
        db_session.add(src)
        await db_session.flush()

        _make_event(
            db_session,
            src,
            event_type="network_flow",
            service="firewall",
            message="allow app01 -> db01:5432",
            fields={
                "src_ip": "10.0.0.10",
                "src_host": "app01",
                "dst_ip": "10.0.0.20",
                "dst_host": "db01",
                "dst_port": 5432,
                "protocol": "tcp",
                "app": "orders-api",
                "bytes_out": 1200,
                "action": "allow",
            },
        )
        _make_event(
            db_session,
            src,
            event_type="network_flow",
            service="firewall",
            message="allow app01 -> db01:5432 again",
            fields={
                "src_ip": "10.0.0.10",
                "src_host": "app01",
                "dst_ip": "10.0.0.20",
                "dst_host": "db01",
                "dst_port": 5432,
                "protocol": "tcp",
                "app": "orders-api",
                "bytes_out": 800,
                "action": "allow",
            },
        )
        _make_event(
            db_session,
            src,
            event_type="log",
            message="ordinary app log",
        )
        await db_session.commit()

        resp = await client.get("/api/v1/metrics/network/map")
        assert resp.status_code == 200
        data = resp.json()

        assert len(data["nodes"]) == 2
        assert {node["label"] for node in data["nodes"]} == {"app01", "db01"}

        assert len(data["edges"]) == 1
        edge = data["edges"][0]
        assert edge["source"] == "app01"
        assert edge["target"] == "db01"
        assert edge["app"] == "orders-api"
        assert edge["protocol"] == "tcp"
        assert edge["dst_port"] == 5432
        assert edge["connections"] == 2
        assert edge["bytes"] == 2000
        assert edge["allowed_count"] == 2

    async def test_enriches_public_targets_with_geo_metadata(self, client, db_session, monkeypatch):
        src = _make_source(db_session, name="geo-src")
        db_session.add(src)
        await db_session.flush()

        _make_event(
            db_session,
            src,
            event_type="network_flow",
            service="dns",
            message="allow app01 -> google-dns:53",
            fields={
                "src_ip": "10.0.0.10",
                "src_host": "app01",
                "dst_ip": "8.8.8.8",
                "dst_host": "google-dns",
                "dst_port": 53,
                "protocol": "udp",
                "bytes_out": 512,
                "action": "allow",
            },
        )
        await db_session.commit()

        async def fake_lookup_geo_points(candidates_by_label: dict[str, str]) -> dict[str, dict]:
            assert candidates_by_label["google-dns"] == "8.8.8.8"
            return {
                "google-dns": {
                    "resolved_ip": "8.8.8.8",
                    "latitude": 37.386,
                    "longitude": -122.0838,
                    "city": "Mountain View",
                    "region": "California",
                    "country": "United States",
                    "country_code": "US",
                    "source": "test",
                }
            }

        monkeypatch.setattr(metrics_api, "_lookup_geo_points", fake_lookup_geo_points)

        resp = await client.get("/api/v1/metrics/network/map")
        assert resp.status_code == 200
        data = resp.json()

        nodes = {node["label"]: node for node in data["nodes"]}
        assert nodes["app01"].get("geo") is None
        assert nodes["google-dns"]["geo"] == {
            "resolved_ip": "8.8.8.8",
            "latitude": 37.386,
            "longitude": -122.0838,
            "city": "Mountain View",
            "region": "California",
            "country": "United States",
            "country_code": "US",
            "source": "test",
        }

    async def test_ignores_non_object_fields_and_normalizes_scalar_edge_metadata(self, client, db_session, monkeypatch):
        src = _make_source(db_session, name="net-malformed")
        db_session.add(src)
        await db_session.flush()

        db_session.add(
            Event(
                source_id=src.id,
                timestamp=datetime.now(timezone.utc),
                severity="info",
                message="malformed network flow",
                service="svc",
                host="host1",
                environment="test",
                event_type="network_flow",
                fields_json=["unexpected", "payload"],
                fingerprint="fp-malformed-network-flow",
            )
        )
        _make_event(
            db_session,
            src,
            event_type="network_flow",
            message="scalar metadata flow",
            service="firewall",
            fields={
                "src_host": "app01",
                "dst_host": "8.8.8.8",
                "protocol": 17,
                "app": 443,
                "bytes_out": 1024,
                "action": True,
            },
        )
        await db_session.commit()

        async def fake_lookup_geo_points(candidates_by_label: dict[str, str]) -> dict[str, dict]:
            assert candidates_by_label["8.8.8.8"] == "8.8.8.8"
            return {
                "8.8.8.8": {
                    "resolved_ip": "8.8.8.8",
                    "latitude": 37.386,
                    "longitude": -122.0838,
                    "city": "Mountain View",
                    "region": "California",
                    "country": "United States",
                    "country_code": "US",
                    "source": "test",
                }
            }

        monkeypatch.setattr(metrics_api, "_lookup_geo_points", fake_lookup_geo_points)

        resp = await client.get("/api/v1/metrics/network/map")

        assert resp.status_code == 200
        data = resp.json()
        assert {node["label"] for node in data["nodes"]} == {"app01", "8.8.8.8"}
        assert len(data["edges"]) == 1
        assert data["edges"][0]["protocol"] == "17"
        assert data["edges"][0]["app"] == "443"
        assert data["edges"][0]["allowed_count"] == 0

    async def test_source_filter_limits_network_graph(self, client, db_session):
        src_a = _make_source(db_session, name="net-a")
        src_b = _make_source(db_session, name="net-b")
        db_session.add_all([src_a, src_b])
        await db_session.flush()

        _make_event(
            db_session,
            src_a,
            event_type="network_flow",
            message="a -> db",
            fields={"src_host": "app-a", "dst_host": "db", "bytes_out": 300},
        )
        _make_event(
            db_session,
            src_b,
            event_type="network_flow",
            message="b -> db",
            fields={"src_host": "app-b", "dst_host": "db", "bytes_out": 900},
        )
        await db_session.commit()

        resp = await client.get(f"/api/v1/metrics/network/map?source_ids={src_b.id}")
        assert resp.status_code == 200
        data = resp.json()

        assert {node["label"] for node in data["nodes"]} == {"app-b", "db"}
        assert len(data["edges"]) == 1
        assert data["edges"][0]["source"] == "app-b"
