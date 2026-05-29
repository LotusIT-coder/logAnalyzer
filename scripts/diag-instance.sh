#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"

BACKEND_PORT=8001
FRONTEND_PORT=5173

echo "== Process snapshot =="
ps -eo pid,ppid,etimes,cmd | rg -i "uvicorn|vite|npm run dev|node.*vite|python.*app.main" || echo "No matching processes"

echo ""
echo "== Ports ${BACKEND_PORT}/${FRONTEND_PORT} =="
ss -ltnp | rg ":${BACKEND_PORT}|:${FRONTEND_PORT}" || echo "No listeners on ${BACKEND_PORT}/${FRONTEND_PORT}"

echo ""
echo "== HTTP checks =="
for entry in "backend_health http://127.0.0.1:${BACKEND_PORT}/api/v1/health" "frontend http://127.0.0.1:${FRONTEND_PORT}/"; do
  name="${entry%% *}"
  url="${entry#* }"
  code="$(curl -sS -o /dev/null -w "%{http_code}" "$url" || true)"
  echo "$name: HTTP $code"
done

echo ""
echo "== Recent backend log =="
if [[ -f "$RUN_DIR/backend.log" ]]; then
  tail -n 60 "$RUN_DIR/backend.log"
else
  echo "No $RUN_DIR/backend.log"
fi

echo ""
echo "== Recent frontend log =="
if [[ -f "$RUN_DIR/frontend.log" ]]; then
  tail -n 60 "$RUN_DIR/frontend.log"
else
  echo "No $RUN_DIR/frontend.log"
fi

echo ""
echo "== User journal crash hints =="
journalctl --user -n 250 --no-pager | rg -i "uvicorn|vite|node|killed|oom|segfault|exception|traceback" || echo "No matching journal hints"

echo ""
echo "== Kernel OOM hints (if accessible) =="
dmesg 2>/dev/null | rg -i "killed process|out of memory|oom" | tail -n 20 || echo "No kernel OOM hints (or no access)"
