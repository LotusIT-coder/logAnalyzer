#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$ROOT_DIR/deploy/systemd/user"
DST_DIR="$HOME/.config/systemd/user"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found. Cannot install user services."
  exit 1
fi

mkdir -p "$DST_DIR"
install -m 0644 "$SRC_DIR/loganalyzer-backend.service" "$DST_DIR/loganalyzer-backend.service"
install -m 0644 "$SRC_DIR/loganalyzer-frontend.service" "$DST_DIR/loganalyzer-frontend.service"
install -m 0644 "$SRC_DIR/loganalyzer-dev.target" "$DST_DIR/loganalyzer-dev.target"

systemctl --user daemon-reload
systemctl --user enable --now loganalyzer-dev.target

echo "Installed and started user services."
echo "Useful commands:"
echo "  systemctl --user status loganalyzer-dev.target"
echo "  journalctl --user -u loganalyzer-backend.service -f"
echo "  journalctl --user -u loganalyzer-frontend.service -f"
