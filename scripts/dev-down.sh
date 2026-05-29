#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"

BACKEND_PORT=8001
FRONTEND_PORT=5173

BACKEND_PID_FILE="$RUN_DIR/backend.pid"
FRONTEND_PID_FILE="$RUN_DIR/frontend.pid"

stop_pidfile() {
  local name="$1"
  local pidfile="$2"

  if [[ ! -f "$pidfile" ]]; then
    echo "$name not tracked (no pidfile)."
    return
  fi

  local pid
  pid="$(cat "$pidfile")"
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "$name already stopped (stale pidfile)."
    rm -f "$pidfile"
    return
  fi

  kill "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$name stopped."
      rm -f "$pidfile"
      return
    fi
    sleep 0.25
  done

  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pidfile"
  echo "$name force-killed."
}

stop_pidfile "Frontend" "$FRONTEND_PID_FILE"
stop_pidfile "Backend" "$BACKEND_PID_FILE"

# Best-effort cleanup for manually started dev processes with matching ports.
pkill -f "uvicorn app.main:app --host 127.0.0.1 --port ${BACKEND_PORT}" 2>/dev/null || true
pkill -f "vite --host 127.0.0.1 --port ${FRONTEND_PORT}" 2>/dev/null || true

echo "Done."
