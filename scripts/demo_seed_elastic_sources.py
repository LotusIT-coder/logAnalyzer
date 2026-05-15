#!/usr/bin/env python3
"""Seed deterministic demo sources and events for Elastic showcase flows.

Creates representative sample log files for source types:
- filebeat
- winlogbeat
- syslog
- elastic_agent

Then ensures matching configured sources exist and triggers ingestion.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class DemoSource:
    name: str
    source_type: str
    filename: str
    lines: tuple[str, ...]


DEMO_SOURCES: tuple[DemoSource, ...] = (
    DemoSource(
        name="demo-filebeat-auth",
        source_type="filebeat",
        filename="filebeat-auth.jsonl",
        lines=(
            '{"@timestamp":"2026-05-15T13:16:01Z","event":{"code":"4625","category":["authentication"]},"host":{"name":"srv-auth-01"},"user":{"name":"administrator"},"source":{"ip":"203.0.113.50"},"process":{"command_line":"powershell.exe -enc SQBuAHYAbwBrAGUALQBXAGUAYgBSAGUAcQB1AGUAcwB0AA=="},"message":"Failed logon attempt for administrator"}',
            '{"@timestamp":"2026-05-15T13:16:15Z","event":{"code":"4624","category":["authentication"]},"host":{"name":"srv-auth-01"},"user":{"name":"administrator"},"source":{"ip":"203.0.113.50"},"process":{"command_line":"powershell.exe -NoProfile"},"message":"Successful logon after multiple failures"}',
        ),
    ),
    DemoSource(
        name="demo-winlogbeat-security",
        source_type="winlogbeat",
        filename="winlogbeat-security.jsonl",
        lines=(
            '{"@timestamp":"2026-05-15T13:17:03Z","event":{"code":"4769","category":["authentication"]},"host":{"name":"dc-01"},"user":{"name":"svc_sql"},"source":{"ip":"10.10.10.21"},"message":"A Kerberos service ticket was requested"}',
            '{"@timestamp":"2026-05-15T13:17:07Z","event":{"code":"4769","category":["authentication"]},"host":{"name":"dc-01"},"user":{"name":"svc_sql"},"source":{"ip":"10.10.10.21"},"message":"A Kerberos service ticket was requested"}',
        ),
    ),
    DemoSource(
        name="demo-syslog-edge",
        source_type="syslog",
        filename="syslog-edge.log",
        lines=(
            "2026-05-15T13:16:06Z edge-gw sshd[1337]: Failed password for invalid user admin from 198.51.100.7 port 54321 ssh2",
            "2026-05-15T13:16:11Z edge-gw sshd[1338]: Failed password for invalid user admin from 198.51.100.7 port 54322 ssh2",
            "2026-05-15T13:16:13Z edge-gw sshd[1339]: Failed password for invalid user admin from 198.51.100.7 port 54323 ssh2",
            "May 15 13:16:14 edge-gw sudo[991]: pam_unix(sudo:session): session opened for user root by analyst(uid=1001)",
        ),
    ),
    DemoSource(
        name="demo-elastic-agent-endpoint",
        source_type="elastic_agent",
        filename="elastic-agent-endpoint.jsonl",
        lines=(
            '{"@timestamp":"2026-05-15T13:18:20Z","event":{"code":"endpoint-process","category":["process"]},"host":{"name":"workstation-17"},"user":{"name":"alice"},"source":{"ip":"10.20.0.17"},"process":{"command_line":"powershell.exe -windowstyle hidden -nop -enc SQBtAHAAbwByAHQALQBNAG8AZAB1AGwAZQAgAFcAaQBuADMANgA0AA=="},"message":"Endpoint observed suspicious PowerShell chain"}',
            '{"@timestamp":"2026-05-15T13:18:45Z","event":{"code":"endpoint-file","category":["file"]},"host":{"name":"workstation-17"},"user":{"name":"alice"},"source":{"ip":"10.20.0.17"},"message":"Persistence indicator: startup folder modification"}',
        ),
    ),
)

_EXTENDED_SOURCE_TYPES = {"filebeat", "winlogbeat", "elastic_agent"}


class ApiError(RuntimeError):
    def __init__(self, method: str, path: str, status_code: int, detail: str) -> None:
        self.method = method
        self.path = path
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"{method} {path} failed with {status_code}: {detail}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed deterministic Elastic showcase sources and events")
    parser.add_argument(
        "--api-base",
        default=os.getenv("LOGANALYZER_API_BASE", "http://localhost:8000/api/v1"),
        help="Base API URL (default: %(default)s)",
    )
    parser.add_argument(
        "--token",
        default=os.getenv("LOGANALYZER_TOKEN") or os.getenv("LOG_ANALYZER_TOKEN"),
        help="Bearer token for authenticated backends",
    )
    parser.add_argument(
        "--seed-dir",
        default="backend/data/uploads/demo-seed-elastic",
        help="Relative path for generated seed files",
    )
    parser.add_argument(
        "--skip-ingestion",
        action="store_true",
        help="Only create/update sources, do not trigger ingestion",
    )
    return parser.parse_args()


def _json_request(api_base: str, method: str, path: str, token: str | None = None, body: dict[str, Any] | None = None) -> Any:
    url = f"{api_base.rstrip('/')}{path}"
    payload = None
    headers = {"Accept": "application/json"}
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"

    request = Request(url=url, method=method, headers=headers, data=payload)
    try:
        with urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ApiError(method, path, exc.code, detail) from exc
    except URLError as exc:
        raise RuntimeError(f"{method} {path} failed: {exc}") from exc


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _write_seed_files(seed_dir: Path) -> list[tuple[DemoSource, Path]]:
    seed_dir.mkdir(parents=True, exist_ok=True)
    written: list[tuple[DemoSource, Path]] = []
    for source in DEMO_SOURCES:
        path = seed_dir / source.filename
        content = "\n".join(source.lines) + "\n"
        path.write_text(content, encoding="utf-8")
        written.append((source, path))
    return written


def _build_source_config(file_path: Path) -> dict[str, Any]:
    config: dict[str, Any] = {
        "path": str(file_path),
        "source_origin": "demo_seed",
    }

    repo_data_root = (_repo_root() / "backend" / "data").resolve()
    try:
        relative = file_path.resolve().relative_to(repo_data_root)
    except ValueError:
        return config

    config["log_path"] = str(Path("/app/data") / relative)
    return config


def _ensure_sources(api_base: str, token: str | None, written: list[tuple[DemoSource, Path]]) -> list[str]:
    existing = _json_request(api_base, "GET", "/sources", token=token)
    items = existing.get("items", []) if isinstance(existing, dict) else []
    by_name = {item.get("name"): item for item in items if isinstance(item, dict)}

    source_ids: list[str] = []
    for source, file_path in written:
        payload = {
            "name": source.name,
            "type": source.source_type,
            "config": _build_source_config(file_path),
            "enabled": True,
        }
        current = by_name.get(source.name)
        if current is None:
            try:
                created = _json_request(api_base, "POST", "/sources", token=token, body=payload)
                fallback_used = False
            except ApiError as exc:
                if exc.status_code == 422 and source.source_type in _EXTENDED_SOURCE_TYPES:
                    fallback_payload = {
                        "name": source.name,
                        "type": "file",
                        "config": {
                            **_build_source_config(file_path),
                            "declared_source_type": source.source_type,
                        },
                        "enabled": True,
                    }
                    created = _json_request(api_base, "POST", "/sources", token=token, body=fallback_payload)
                    fallback_used = True
                else:
                    raise RuntimeError(str(exc)) from exc
            source_id = created.get("id")
            if fallback_used:
                print(f"[create] source {source.name} (fallback type=file, declared={source.source_type})")
            else:
                print(f"[create] source {source.name} ({source.source_type})")
        else:
            source_id = current.get("id")
            patch_payload = {
                "name": source.name,
                "config": {
                    **_build_source_config(file_path),
                    "declared_source_type": source.source_type,
                },
                "enabled": True,
            }
            _json_request(api_base, "PATCH", f"/sources/{source_id}", token=token, body=patch_payload)
            print(f"[update] source {source.name} ({source.source_type})")

        if not isinstance(source_id, str) or not source_id:
            raise RuntimeError(f"Missing source id for {source.name}")
        source_ids.append(source_id)

    return source_ids


def _trigger_ingestion(api_base: str, token: str | None, source_ids: list[str]) -> None:
    response = _json_request(
        api_base,
        "POST",
        "/ingestion/run",
        token=token,
        body={"source_ids": source_ids},
    )
    results = response.get("results", []) if isinstance(response, dict) else []
    print("[ingestion] triggered")
    for item in results:
        if not isinstance(item, dict):
            continue
        sid = item.get("source_id", "?")
        lines = item.get("lines_ingested", 0)
        events = item.get("events_created", 0)
        skipped = item.get("skipped", False)
        reason = item.get("reason")
        if skipped:
            print(f"  - {sid}: skipped ({reason})")
        else:
            print(f"  - {sid}: lines={lines}, events={events}")


def _check_api_ready(api_base: str, token: str | None) -> None:
    try:
        _json_request(api_base, "GET", "/health", token=token)
    except Exception as exc:  # noqa: BLE001 - user-facing preflight error
        raise RuntimeError(
            f"API not reachable at {api_base}. Start backend first (e.g. ./scripts/dev-up.sh). Root cause: {exc}"
        ) from exc


def main() -> int:
    args = parse_args()
    repo_root = _repo_root()
    seed_dir = (repo_root / args.seed_dir).resolve()

    print(f"[seed] writing demo logs to {seed_dir}")
    written = _write_seed_files(seed_dir)
    for source, file_path in written:
        print(f"  - {source.name}: {file_path}")

    try:
        _check_api_ready(args.api_base, args.token)
        source_ids = _ensure_sources(args.api_base, args.token, written)
        if not args.skip_ingestion:
            _trigger_ingestion(args.api_base, args.token, source_ids)
        else:
            print("[ingestion] skipped by --skip-ingestion")
    except RuntimeError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1

    print("[done] demo seed completed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
