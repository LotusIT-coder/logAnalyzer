#!/bin/bash
TOTAL_SAMPLES=24
SLEEP_INTERVAL=30
SAMPLES_FILE="/tmp/stability_samples.txt"
rm -f "$SAMPLES_FILE"

echo "Starting 12-minute stability test ($TOTAL_SAMPLES samples, 30s interval)..."

for i in $(seq 1 $TOTAL_SAMPLES); do
  TIMESTAMP=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  MARKER="STABILITY_1M_$(date +%s)_$i"
  logger "$MARKER"
  sleep 2
  
  FROM=$(date -u -d '1 minute ago' +'%Y-%m-%dT%H:%M:%SZ')
  TO=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  
  API_JSON=$(curl -sS "http://127.0.0.1:8000/api/v1/events?provider=postgres&from=${FROM}&to=${TO}&limit=100&q=STABILITY_1M_")
  API_COUNT=$(echo "$API_JSON" | grep -o '"id"' | wc -l)
  
  DB_LAST_1M=$(PGPASSWORD=changeme psql -h 127.0.0.1 -U loganalyzer -d loganalyzer -Atc "select count(*) from event where created_at >= now() - interval '1 minute';")
  DB_MARKER_2M=$(PGPASSWORD=changeme psql -h 127.0.0.1 -U loganalyzer -d loganalyzer -Atc "select count(*) from event where message ilike '%STABILITY_1M_%' and created_at >= now() - interval '2 minutes';")
  
  FAIL=0
  [[ -z "$API_JSON" ]] && FAIL=1
  [[ "$DB_LAST_1M" -eq 0 ]] && FAIL=1
  [[ "$DB_MARKER_2M" -eq 0 ]] && FAIL=1
  
  echo "$TIMESTAMP $API_COUNT $DB_LAST_1M $DB_MARKER_2M $FAIL" >> "$SAMPLES_FILE"
  echo "Sample $i/$TOTAL_SAMPLES: API=$API_COUNT, DB_1M=$DB_LAST_1M, DB_MARKER_2M=$DB_MARKER_2M, Fail=$FAIL"
  
  if [ $i -lt $TOTAL_SAMPLES ]; then sleep $((SLEEP_INTERVAL - 2)); fi
done

echo "Test complete. Computing stats..."
SAMPLES_TOTAL=$(wc -l < "$SAMPLES_FILE")
FAILURES_TOTAL=$(awk '$5 == 1 {count++} END {print count+0}' "$SAMPLES_FILE")
MIN_DB=$(awk 'NR==1 {min=$3} {if($3<min) min=$3} END {print min}' "$SAMPLES_FILE")
MAX_DB=$(awk 'NR==1 {max=$3} {if($3>max) max=$3} END {print max}' "$SAMPLES_FILE")
MED_DB=$(awk '{print $3}' "$SAMPLES_FILE" | sort -n | awk '{a[NR]=$1} END {if (NR%2==1) print a[(NR+1)/2]; else print (a[NR/2]+a[NR/2+1])/2}')
FAILED_TIMESTAMPS=$(awk '$5 == 1 {print $1}' "$SAMPLES_FILE" | xargs)
STATUS="PASS"
[[ $FAILURES_TOTAL -gt 0 ]] && STATUS="FAIL"

echo "----------------------------------------"
echo "Samples Total: $SAMPLES_TOTAL"
echo "Failures Total: $FAILURES_TOTAL"
echo "Status: $STATUS"
echo "Min/Max/Median DB_Last_1M: $MIN_DB / $MAX_DB / $MED_DB"
echo "Failed Timestamps: $FAILED_TIMESTAMPS"
echo "----------------------------------------"
echo "First 5 samples:"
head -n 5 "$SAMPLES_FILE"
echo "Last 5 samples:"
tail -n 5 "$SAMPLES_FILE"
