# Attack Simulation Dataset

A one-button demo that turns the logAnalyzer into a fully-loaded SOC workbench
in under 30 seconds. Designed to give recruiters and stakeholders an immediate
feel for what the platform can do:

* what raw events look like,
* what the rule engine detects,
* how correlation links scattered events into one incident,
* how the AI SOC-Analyst summarises threats.

## Quick start

```bash
# 1. Start the stack (see README.md in the repo root)
./scripts/dev-up.sh

# 2. Seed the attack simulation (idempotent – safe to re-run any time)
python scripts/demo_attack_simulation.py
```

Then open the frontend (default <http://localhost:5173>):

* **Dashboard** – the top-error and severity charts immediately spike.
* **Events** – pick one of the `demo-attack-*` sources to see the raw log lines.
* **Rules** – the `demo-rule-*` rules are pre-created and enabled.
* **Incidents** – correlated incidents appear within seconds of ingestion.

All timestamps are generated relative to *now*, so the events always fall
inside the default 15-minute window.

## Scenarios

Each scenario lives in its own log file under
`backend/data/uploads/demo-attack-scenarios/` and is mapped to a dedicated
source plus one or more detection rules.

| # | Scenario | MITRE | Source type | Highlights |
|---|----------|-------|-------------|------------|
| 1 | **SSH brute force + compromise** | T1110, T1078 | syslog | 8 failed logins → 1 success → curl payload → execution |
| 2 | **Linux privilege escalation** | T1548 | syslog | sudo + `cat /etc/shadow`, SUID enumeration, vim shell escape |
| 3 | **Obfuscated PowerShell** | T1059.001, T1027 | filebeat | `powershell -enc <base64>`, recon, new domain admin |
| 4 | **Kerberoasting** | T1558.003 | winlogbeat | 7 × Event 4769 (RC4-HMAC) for service accounts |
| 5 | **SQL injection** | T1190 | file (JSON) | sqlmap signatures: `UNION SELECT`, `OR 1=1`, `SLEEP(...)` |
| 6 | **Port scan** | T1046 | syslog | 22 × UFW BLOCK across well-known ports from one IP |
| 7 | **Data exfiltration** | T1041 | file (JSON) | 5 × ~250 MB outbound flows to suspicious external IP |
| 8 | **Ransomware in progress** | T1490, T1486 | elastic_agent | `vssadmin delete shadows`, mass rename to `.LOCKED`, ransom note |
| – | **Baseline noise** | – | file (JSON) | 15 benign `myapp` requests so attacks stand out |

## Detection rules

Ten rules are created (`demo-rule-*`). Notable ones:

* **`demo-rule-ssh-bruteforce-success`** – *sequence rule*: `Failed password`
  → `Accepted password` on the same host within 5 min. Produces a **critical**
  incident — a great showcase for cross-event correlation.
* **`demo-rule-kerberoasting`** – threshold rule: 6+ Event-4769 within 60s
  grouped by host.
* **`demo-rule-ransomware-shadow-delete`** – fires on a single
  `vssadmin delete shadows` event (impact tactic, critical severity).

All rules carry their MITRE technique / tactic so the incident detail view
displays the attack chain.

## Re-running the demo

The script is idempotent:

* log files are overwritten with fresh timestamps,
* existing sources/rules with matching names are patched in-place,
* ingestion is re-triggered.

This makes it safe to bind to a button or run repeatedly during a live
presentation.

## CLI options

```text
python scripts/demo_attack_simulation.py --help

  --api-base URL        Backend API base (default: http://localhost:8000/api/v1
                        or $LOGANALYZER_API_BASE)
  --token TOKEN         Bearer token for authenticated backends
  --seed-dir PATH       Where to write log files
                        (default: backend/data/uploads/demo-attack-scenarios)
  --skip-ingestion      Register sources/rules but do not ingest
  --skip-rules          Do not create/update detection rules
  --files-only          Only write log files; do not call the API
```

## File layout

```
scripts/demo_attack_simulation.py       # seeder (self-contained, stdlib only)
demo/attack-scenarios/README.md         # this file
backend/data/uploads/demo-attack-scenarios/
    ssh-bruteforce.log                  # generated at runtime
    linux-privesc.log
    windows-powershell.jsonl
    kerberoasting.jsonl
    sql-injection.jsonl
    port-scan.log
    data-exfiltration.jsonl
    ransomware.jsonl
    baseline-noise.jsonl
```

## Disclaimer

All IP addresses, hostnames, usernames and payloads are fictional and used
purely for demonstration purposes. The base64 strings in the PowerShell
scenario decode to harmless `New-Object System.Net.WebClient` fragments.
```
