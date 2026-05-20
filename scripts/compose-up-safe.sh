#!/usr/bin/env bash
set -euo pipefail

# Safe wrapper around docker compose up that auto-recovers from the known
# docker-compose v1 bug: KeyError: 'ContainerConfig'.
#
# Usage:
#   ./scripts/compose-up-safe.sh
#   ./scripts/compose-up-safe.sh backend
#   ./scripts/compose-up-safe.sh --build backend

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "Neither 'docker compose' nor 'docker-compose' is available."
  exit 127
fi

UP_ARGS=("$@")
if [[ ${#UP_ARGS[@]} -eq 0 ]]; then
  UP_ARGS=(--build)
fi

echo "Using: ${COMPOSE_CMD[*]}"
echo "Running: ${COMPOSE_CMD[*]} up -d ${UP_ARGS[*]}"

TMP_OUT="$(mktemp /tmp/compose-up-safe-XXXXXX.log)"
trap 'rm -f "$TMP_OUT"' EXIT

set +e
"${COMPOSE_CMD[@]}" up -d "${UP_ARGS[@]}" >"$TMP_OUT" 2>&1
STATUS=$?
set -e

if [[ $STATUS -eq 0 ]]; then
  cat "$TMP_OUT"
  echo "Compose up completed successfully."
  exit 0
fi

cat "$TMP_OUT"

if grep -q "KeyError: 'ContainerConfig'" "$TMP_OUT"; then
  echo ""
  echo "Detected docker-compose v1 ContainerConfig bug. Running cleanup + retry..."
  "${COMPOSE_CMD[@]}" down --remove-orphans || true
  "${COMPOSE_CMD[@]}" up -d "${UP_ARGS[@]}"
  echo "Recovery retry completed."
  exit 0
fi

echo "Compose up failed (non-recoverable by this wrapper)."
exit $STATUS
