#!/usr/bin/env python3
"""Trigger a live SOC monitoring demo.

This script:
- finds the configured Journald source
- enables SOC monitoring for that source
- emits a small burst of suspicious log messages via logger
- polls for SOC events so you can see the model react

Run from the repository root:

    ./scripts/demo_soc_monitoring.py
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


def http_json(method: str, url: str, body: dict[str, Any] | None = None) -> Any:
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Accept", "application/json")
    if data is not None:
      request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=10) as response:
        payload = response.read().decode("utf-8", errors="replace")
    return json.loads(payload)


def choose_journald_source(api_base: str, preferred_name: str) -> dict[str, Any]:
    payload = http_json("GET", f"{api_base}/sources")
    sources = payload.get("items", payload if isinstance(payload, list) else [])

    if not isinstance(sources, list):
        raise SystemExit("Unexpected /sources response format")

    for source in sources:
        if not isinstance(source, dict):
            continue
        if source.get("type") == "journald" and source.get("name") == preferred_name:
            return source

    for source in sources:
        if isinstance(source, dict) and source.get("type") == "journald":
            return source

    raise SystemExit(f"No journald source found. Available sources: {', '.join(str(s.get('name', s.get('id'))) for s in sources if isinstance(s, dict))}")


def emit_demo_logs(count: int) -> None:
    messages = [
        "Failed password for invalid user admin from 203.0.113.10 port 55123 ssh2",
        "Failed password for invalid user admin from 203.0.113.10 port 55124 ssh2",
        "Possible brute-force pattern detected for ssh",
        "pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=203.0.113.10",
        "Suspicious sudo attempt from user admin on host Rechenknecht",
    ]

    for index in range(count):
        message = messages[index % len(messages)]
        subprocess.run(["logger", "-t", "soc-demo", "-p", "authpriv.warning", message], check=True)
        print(f"emitted: {message}")
        time.sleep(0.5)


def poll_soc_events(api_base: str, timeout_seconds: int, known_incident_ids: set[str], start_tick_count: int) -> int:
    start = time.time()
    max_tick = start_tick_count
    while time.time() - start < timeout_seconds:
        try:
            incidents_payload = http_json("GET", f"{api_base}/incidents?status=open")
            incidents = incidents_payload.get("items", [])
            if isinstance(incidents, list):
                ai_soc_incidents = [
                    incident for incident in incidents
                    if isinstance(incident, dict)
                    and "ai_soc" in (incident.get("tags") or [])
                ]
                for incident in ai_soc_incidents:
                    incident_id = str(incident.get("id", ""))
                    if incident_id and incident_id not in known_incident_ids:
                        print("SOC incident created:")
                        print(f"- id: {incident_id}")
                        print(f"- title: {incident.get('title')}")
                        print(f"- severity: {incident.get('severity')}")
                        print(f"- summary: {incident.get('summary')}")
                        return 0

            status_payload = http_json("GET", f"{api_base}/system/soc-analyst")
            tick_count = int(status_payload.get("tick_count", 0))
            if tick_count > max_tick:
                max_tick = tick_count
                print(f"SOC tick observed: {tick_count}")
        except urllib.error.URLError as error:
            print(f"poll failed: {error}")

        print("waiting for SOC tick...")
        time.sleep(5)

    print("No new AI-SOC incident surfaced within the timeout window.")
    if max_tick > start_tick_count:
        print("SOC service is running and ticking, but no detection crossed the threshold in this run.")
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Trigger a live SOC monitoring demo.")
    parser.add_argument("--api-base", default="http://127.0.0.1:8000/api/v1", help="Backend API base URL")
    parser.add_argument("--source-name", default="Journald", help="Preferred journald source name")
    parser.add_argument("--emit-count", type=int, default=5, help="Number of demo log lines to emit")
    parser.add_argument("--timeout", type=int, default=90, help="Seconds to wait for SOC events")
    args = parser.parse_args()

    source = choose_journald_source(args.api_base, args.source_name)
    source_id = str(source["id"])
    source_name = str(source.get("name", source_id))

    print(f"Using source: {source_name} ({source_id})")
    print("Enabling SOC monitoring...")
    status = http_json("PUT", f"{args.api_base}/system/soc-analyst", {"enabled": True, "source_ids": [source_id]})
    print(json.dumps(status, indent=2, ensure_ascii=False))

    start_tick_count = int(status.get("tick_count", 0))
    known_incident_ids: set[str] = set()
    open_incidents_payload = http_json("GET", f"{args.api_base}/incidents?status=open")
    open_incidents = open_incidents_payload.get("items", [])
    if isinstance(open_incidents, list):
        for incident in open_incidents:
            if not isinstance(incident, dict):
                continue
            tags = incident.get("tags") or []
            if "ai_soc" in tags:
                known_incident_ids.add(str(incident.get("id", "")))

    print("Emitting suspicious log burst...")
    emit_demo_logs(args.emit_count)

    print("Polling for SOC analysis results...")
    return poll_soc_events(args.api_base, args.timeout, known_incident_ids, start_tick_count)


if __name__ == "__main__":
    raise SystemExit(main())