#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:8000}"
SOURCE_ID="${SOURCE_ID:-6c7c6258-4d33-45ff-abce-6256dcc91e38}"
LOG_FILE="${LOG_FILE:-/var/log/tuxguard/tuxguard.log}"

if [[ ! -f "$LOG_FILE" ]]; then
  echo "ERROR: Log file not found: $LOG_FILE" >&2
  exit 1
fi

last_line="$(tail -n 1 "$LOG_FILE")"
if [[ -z "$last_line" ]]; then
  echo "ERROR: Log file is empty: $LOG_FILE" >&2
  exit 1
fi

# Expected prefix format: YYYY-MM-DD HH:MM:SS,mmm
file_ts_local="$(echo "$last_line" | sed -E 's/^([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}),([0-9]{3}).*/\1.\2/')"

api_json="$(curl -sS "$API_BASE_URL/api/v1/events?limit=1&provider=postgres&source_ids=$SOURCE_ID")"
api_ts="$(echo "$api_json" | jq -r '.items[0].timestamp // empty')"
api_msg="$(echo "$api_json" | jq -r '.items[0].message // empty')"

if [[ -z "$api_ts" ]]; then
  echo "ERROR: No API event found for source_id=$SOURCE_ID"
  exit 1
fi

# Convert both timestamps to epoch seconds in local parse context.
# API timestamp carries explicit UTC (Z), file timestamp is local wall-clock.
file_epoch="$(date -d "$file_ts_local" +%s)"
api_epoch="$(date -d "$api_ts" +%s)"
lag_seconds=$((file_epoch - api_epoch))
if (( lag_seconds < 0 )); then
  lag_seconds=$(( -lag_seconds ))
fi

echo "Sync probe"
echo "  source_id: $SOURCE_ID"
echo "  file_ts_local: $file_ts_local"
echo "  api_ts_utc: $api_ts"
echo "  lag_seconds_abs: $lag_seconds"
echo "  file_line: $last_line"
echo "  api_message: $api_msg"

if (( lag_seconds <= 2 )); then
  echo "  verdict: OK (near realtime)"
elif (( lag_seconds <= 10 )); then
  echo "  verdict: WARN (small lag)"
else
  echo "  verdict: LAG (significant delay)"
fi
