#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
mkdir -p "$RUN_DIR"

BACKEND_PID_FILE="$RUN_DIR/backend.pid"
FRONTEND_PID_FILE="$RUN_DIR/frontend.pid"
BACKEND_LOG="$RUN_DIR/backend.log"
FRONTEND_LOG="$RUN_DIR/frontend.log"

is_pid_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

wait_http() {
  local url="$1"
  local attempts="${2:-20}"
  local delay_seconds="${3:-0.5}"
  local i

  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay_seconds"
  done

  return 1
}

port_is_listening() {
  local port="$1"
  ss -ltn "( sport = :$port )" | rg -q ":$port"
}

start_backend() {
  if [[ -f "$BACKEND_PID_FILE" ]] && is_pid_alive "$(cat "$BACKEND_PID_FILE")"; then
    echo "Backend already running (pid $(cat "$BACKEND_PID_FILE"))."
    return
  fi

  if port_is_listening 8000 && wait_http "http://127.0.0.1:8000/api/v1/health" 2 0.2; then
    echo "Backend already running (untracked, port 8000 in use)."
    return
  fi

  rm -f "$BACKEND_PID_FILE"
  nohup bash -lc "cd '$ROOT_DIR/backend' && source .venv/bin/activate && exec uvicorn app.main:app --host 127.0.0.1 --port 8000" \
    >"$BACKEND_LOG" 2>&1 &
  echo "$!" >"$BACKEND_PID_FILE"

  if wait_http "http://127.0.0.1:8000/api/v1/health"; then
    echo "Backend started (pid $(cat "$BACKEND_PID_FILE"))."
  else
    echo "Backend did not become healthy. Check $BACKEND_LOG"
    return 1
  fi
}

start_frontend() {
  if [[ -f "$FRONTEND_PID_FILE" ]] && is_pid_alive "$(cat "$FRONTEND_PID_FILE")"; then
    echo "Frontend already running (pid $(cat "$FRONTEND_PID_FILE"))."
    return
  fi

  if port_is_listening 5173 && wait_http "http://127.0.0.1:5173/" 2 0.2; then
    echo "Frontend already running (untracked, port 5173 in use)."
    return
  fi

  rm -f "$FRONTEND_PID_FILE"
  nohup bash -lc "cd '$ROOT_DIR/frontend' && exec npm run dev -- --host 127.0.0.1 --port 5173" \
    >"$FRONTEND_LOG" 2>&1 &
  echo "$!" >"$FRONTEND_PID_FILE"

  if wait_http "http://127.0.0.1:5173/"; then
    echo "Frontend started (pid $(cat "$FRONTEND_PID_FILE"))."
  else
    echo "Frontend did not become ready. Check $FRONTEND_LOG"
    return 1
  fi
}

start_backend
start_frontend

echo ""
echo "App URLs:"
echo "  - Frontend: http://127.0.0.1:5173"
echo "  - Backend API: http://127.0.0.1:8000"
echo "Logs:"
echo "  - $BACKEND_LOG"
echo "  - $FRONTEND_LOG"
