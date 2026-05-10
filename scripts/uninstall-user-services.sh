#!/usr/bin/env bash
set -euo pipefail

DST_DIR="$HOME/.config/systemd/user"

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now loganalyzer-dev.target 2>/dev/null || true
  systemctl --user disable --now loganalyzer-backend.service 2>/dev/null || true
  systemctl --user disable --now loganalyzer-frontend.service 2>/dev/null || true
  systemctl --user daemon-reload
fi

rm -f "$DST_DIR/loganalyzer-dev.target"
rm -f "$DST_DIR/loganalyzer-backend.service"
rm -f "$DST_DIR/loganalyzer-frontend.service"

echo "User services removed."
