import subprocess
import time
import datetime
import json
import statistics

def run_cmd(cmd):
    return subprocess.check_output(cmd, shell=True, text=True).strip()


def get_db_val(query):
    try:
        return run_cmd(f"PGPASSWORD=changeme psql -h 127.0.0.1 -U loganalyzer -d loganalyzer -Atc \"{query}\"")
    except:
        return "0"


def get_target_source_ids():
    # Restrict search to the two sources where `logger` markers are expected.
    query = (
        "select id from source "
        "where enabled = true and lower(name) in ('syslog', 'journald') "
        "order by lower(name);"
    )
    raw = get_db_val(query)
    if not raw:
        return []
    return [line.strip() for line in raw.splitlines() if line.strip()]


def fetch_events(from_time, to_time, source_ids):
    events = []
    if source_ids:
        for source_id in source_ids:
            try:
                payload = run_cmd(
                    f"curl -sS 'http://127.0.0.1:8000/api/v1/events?provider=postgres&from={from_time}&to={to_time}&limit=300&source_id={source_id}'"
                )
                data = json.loads(payload)
                if isinstance(data, dict):
                    items = data.get("items", [])
                    if isinstance(items, list):
                        events.extend(items)
                elif isinstance(data, list):
                    events.extend(data)
            except:
                continue
    else:
        try:
            payload = run_cmd(
                f"curl -sS 'http://127.0.0.1:8000/api/v1/events?provider=postgres&from={from_time}&to={to_time}&limit=500'"
            )
            data = json.loads(payload)
            if isinstance(data, dict):
                items = data.get("items", [])
                if isinstance(items, list):
                    events.extend(items)
            elif isinstance(data, list):
                events.extend(data)
        except:
            pass
    return events


target_source_ids = get_target_source_ids()

results = []
for idx in range(1, 25):
    # Use alnum-only markers so SQL/ILIKE wildcard characters are not involved.
    marker = f"S1MROBUST{int(time.time())}X{idx}"
    subprocess.run(f"logger '{marker}'", shell=True)
    
    attempts_used = 0
    api_seen = 0
    db_last_1m = 0
    passed = False
    
    # Retry loop for up to 15s (5 attempts, 3s sleep)
    for attempt in range(1, 6):
        attempts_used = attempt
        time.sleep(3)

        now_utc = datetime.datetime.now(datetime.UTC)
        from_time = (now_utc - datetime.timedelta(minutes=2)).strftime('%Y-%m-%dT%H:%M:%SZ')
        to_time = now_utc.strftime('%Y-%m-%dT%H:%M:%SZ')

        events = fetch_events(from_time, to_time, target_source_ids)
        for event in events:
            message = event.get("message", "") if isinstance(event, dict) else ""
            if isinstance(message, str) and marker in message:
                api_seen = 1
                break
        
        # Check DB last 1m load
        db_last_1m = int(get_db_val("select count(*) from event where created_at >= now() - interval '1 minute';"))
        
        if api_seen:
            passed = True
            break
            
    results.append({
        "timestamp": datetime.datetime.now().isoformat(),
        "marker": marker,
        "attempts": attempts_used,
        "api_seen": api_seen,
        "db_last_1m": db_last_1m,
        "pass": passed
    })
    
    if idx < 24:
        time.sleep(27) # Cadence ~30s (3s + 27s)

total = len(results)
passed_count = sum(1 for r in results if r['pass'])
failed_count = total - passed_count
db_last_1m_vals = [r['db_last_1m'] for r in results]

print(f"--- STABILITY TEST REPORT ---")
print(f"Total samples: {total}")
print(f"Pass: {passed_count}")
print(f"Fail: {failed_count}")
if db_last_1m_vals:
    print(f"DB Last 1m: min={min(db_last_1m_vals)}, max={max(db_last_1m_vals)}, median={statistics.median(db_last_1m_vals)}")
print(f"Overall Status: {'PASS' if failed_count == 0 else 'FAIL'}")

if failed_count > 0:
    print("\nFailed Samples:")
    for r in results:
        if not r['pass']:
            print(f"- {r['timestamp']}: {r['marker']}")

print("\nFirst 5 Samples:")
for r in results[:5]:
    print(r)

print("\nLast 5 Samples:")
for r in results[-5:]:
    print(r)
