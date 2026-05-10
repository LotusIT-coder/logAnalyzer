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
