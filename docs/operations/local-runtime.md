# Local Runtime Operations

This project now includes two operation modes:

1. Script-based process management (no systemd)
2. systemd user services (auto-restart on failure)

## 1) Script-Based Runtime

From project root:

```bash
./scripts/dev-up.sh
./scripts/dev-status.sh
./scripts/dev-down.sh
./scripts/diag-instance.sh
```

Behavior:
- `dev-up.sh` starts backend + frontend detached and stores PIDs in `.run/`.
- Logs are written to `.run/backend.log` and `.run/frontend.log`.
- `dev-status.sh` reports process + HTTP health.
- `diag-instance.sh` prints process/port/HTTP snapshots and crash hints.

## 2) systemd User Services (Recommended)

Install and start:

```bash
./scripts/install-user-services.sh
```

Useful commands:

```bash
systemctl --user status loganalyzer-dev.target
systemctl --user restart loganalyzer-dev.target
systemctl --user stop loganalyzer-dev.target
journalctl --user -u loganalyzer-backend.service -f
journalctl --user -u loganalyzer-frontend.service -f
```

Remove services:

```bash
./scripts/uninstall-user-services.sh
```

## Crash Diagnosis Summary

A quick triage found no explicit crash traces (no OOM-killer hints, no traceback in runtime logs).
The prior outage looked consistent with dev processes not running anymore (for example after terminal/session interruption), not with an app startup regression.

For future incidents, run:

```bash
./scripts/diag-instance.sh
```

and inspect:
- `.run/backend.log`
- `.run/frontend.log`
- `journalctl --user` output

## Maintainer Sync Checklist

When changing features, API behavior, startup flow, ports, or deployment defaults, always update docs and container files in the same change set.

- Keep `README.md` current (setup steps, URLs, health checks, known limitations)
- Keep Docker artifacts current (`docker-compose.yml`, `backend/Dockerfile`, `frontend/Dockerfile`, `frontend/nginx.conf`)
- Re-validate with `docker compose up --build -d`
- Verify API health via `http://localhost:8000/api/v1/health`
- Verify frontend API proxy via `http://localhost:8080/api/v1/health`

## Optional Elasticsearch Profile

Start stack with Elastic enabled:

```bash
ELASTIC_ENABLED=true docker compose --profile elastic up --build -d
```

Start stack with Elastic + outbox indexer worker:

```bash
ELASTIC_ENABLED=true ELASTIC_INDEXER_ENABLED=true docker compose --profile elastic up --build -d
```

Quick validation:

```bash
curl -fsS http://localhost:8000/api/v1/health
curl -fsS http://localhost:9200
```

Expected health fields from backend: `elastic_enabled`, `elastic_available`, `elastic_bootstrap_ok`, `elastic_indexer_running`.

Event search provider diagnostics:

```bash
curl -i "http://localhost:8000/api/v1/events?limit=1&provider=auto"
curl -i "http://localhost:8000/api/v1/events?limit=1&provider=postgres"
curl -i "http://localhost:8000/api/v1/events?limit=1&provider=elastic"
```

Check response header `X-Events-Provider`.

Backfill historical events into outbox:

```bash
cd backend
source .venv/bin/activate
python -m app.services.elastic_backfill --batch-size 1000
```
