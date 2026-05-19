#!/usr/bin/env bash
set -euo pipefail

# Convert any proprietary/binary log file using an external decoder and import
# the decoded text into LogAnalyzer.
#
# Requirements:
# - A decoder command must be provided via BINARY_LOG_DECODER_CMD.
# - Backend API reachable (default: http://127.0.0.1:8000/api/v1)
#
# Example:
#   BINARY_LOG_DECODER_CMD='mydecoder --to-text' \
#   ./scripts/import_binary_log.sh /path/to/file.binlog "Game Session 2026-05-19"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <path-to-binary-log> [source-name]"
  exit 2
fi

INPUT_FILE="$1"
SOURCE_NAME="${2:-}"

if [[ ! -f "$INPUT_FILE" ]]; then
  echo "Input file not found: $INPUT_FILE"
  exit 1
fi

if [[ -z "$SOURCE_NAME" ]]; then
  SOURCE_NAME="BinaryLog: $(basename "$INPUT_FILE")"
fi

API_BASE="${LOGANALYZER_API_BASE:-http://127.0.0.1:8000/api/v1}"
IMPORT_URL="${API_BASE%/}/upload/import"

DECODER_CMD="${BINARY_LOG_DECODER_CMD:-}"
if [[ -z "$DECODER_CMD" ]]; then
  echo "Set BINARY_LOG_DECODER_CMD to your decoder command."
  echo "Example: BINARY_LOG_DECODER_CMD='mydecoder --to-text' $0 '$INPUT_FILE'"
  exit 1
fi

DECODER_BIN="${DECODER_CMD%% *}"
if ! command -v "$DECODER_BIN" >/dev/null 2>&1; then
  echo "Decoder executable not found: $DECODER_BIN"
  exit 1
fi

TMP_TXT="$(mktemp /tmp/import-binary-log-XXXXXX.log)"
trap 'rm -f "$TMP_TXT"' EXIT

# shellcheck disable=SC2086
$DECODER_CMD "$INPUT_FILE" > "$TMP_TXT"

if [[ ! -s "$TMP_TXT" ]]; then
  echo "Decoder produced empty output."
  exit 1
fi

CURL_ARGS=(
  -fsS
  -X POST "$IMPORT_URL"
  -F "file=@$TMP_TXT;type=text/plain"
  -F "source_name=$SOURCE_NAME"
)

if [[ -n "${LOGANALYZER_TOKEN:-}" ]]; then
  CURL_ARGS+=( -H "Authorization: Bearer ${LOGANALYZER_TOKEN}" )
fi

echo "Importing decoded log into LogAnalyzer..."
curl "${CURL_ARGS[@]}"
echo
echo "Done."
