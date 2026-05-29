#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"

BACKEND_PORT=8001
FRONTEND_PORT=5173

BACKEND_PID_FILE="$RUN_DIR/backend.pid"
FRONTEND_PID_FILE="$RUN_DIR/frontend.pid"

show_proc_state() {
  local name="$1"
  local pidfile="$2"
  local port="$3"

  if [[ -f "$pidfile" ]]; then
    local pid
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "$name: running (pid $pid)"
      return
    fi
    echo "$name: stopped (stale pidfile: $pid)"
    return
  fi

  if ss -ltn "( sport = :$port )" | rg -q ":$port"; then
    echo "$name: running (untracked, port $port in use)"
    return
  fi

  echo "$name: not tracked"
}

show_http_state() {
  local name="$1"
  local url="$2"

  local code
  code="$(curl -sS -o /dev/null -w "%{http_code}" "$url" || true)"
  if [[ "$code" == "200" ]]; then
    echo "$name endpoint: ok (200)"
  else
    echo "$name endpoint: $code"
  fi
}

echo "Process state"
show_proc_state "Backend" "$BACKEND_PID_FILE" "$BACKEND_PORT"
show_proc_state "Frontend" "$FRONTEND_PID_FILE" "$FRONTEND_PORT"

echo ""
echo "HTTP state"
show_http_state "Backend health" "http://127.0.0.1:${BACKEND_PORT}/api/v1/health"
show_http_state "Frontend" "http://127.0.0.1:${FRONTEND_PORT}/"

echo ""
echo "Listening ports"
ss -ltnp | rg ":${BACKEND_PORT}|:${FRONTEND_PORT}" || echo "No listeners on ${BACKEND_PORT}/${FRONTEND_PORT}"

if ss -ltn "( sport = :8000 )" | rg -q ":8000"; then
  echo "WARNING: legacy backend listener detected on port 8000 (can cause dual-instance confusion)."
fi
