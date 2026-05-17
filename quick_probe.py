import subprocess
import time
import requests
import sys

def check_health():
    for _ in range(20):
        try:
            r = requests.get("http://127.0.0.1:8000/api/v1/health", timeout=2)
            if r.status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(1)
    return False

def get_db_val(query):
    try:
        return subprocess.check_output(f"PGPASSWORD=changeme psql -h 127.0.0.1 -U loganalyzer -d loganalyzer -Atc \"{query}\"", shell=True, text=True).strip()
    except Exception:
        return "0"

if not check_health():
    print("Health check failed")
    sys.exit(1)

results = []
for idx in range(1, 9):
    marker = f"QUICK_PROBE_{int(time.time())}_{idx}"
    subprocess.run(f"logger '{marker}'", shell=True)
    
    found = False
    for _ in range(5):
        time.sleep(2)
        try:
            # Updating search endpoint if needed, but keeping the logic to search for the marker
            r = requests.get("http://127.0.0.1:8000/api/v1/logs/search?q=" + marker, timeout=2)
            if r.status_code == 200:
                data = r.json()
                # Check if 'items' or the list itself contains the marker
                logs = data.get('items', data) if isinstance(data, dict) else data
                if any(marker in str(log) for log in logs):
                    found = True
                    break
        except Exception:
            pass
    
    # Using 'event' table as discovered from \dt
    db_count = get_db_val(f"SELECT count(*) FROM event WHERE message LIKE '%{marker}%'")
    results.append((marker, found, int(db_count)))
    if idx < 8:
        time.sleep(4)

passed_count = sum(1 for r in results if r[1] and r[2] > 0)
quick_result = "PASS" if passed_count >= 6 else "FAIL"

print(f"QUICK_RESULT: {quick_result}")
print(f"SAMPLES: {results}")

try:
    log_content = subprocess.check_output("grep -E 'watcher_source_timeout|watcher_tick_skipped' /tmp/loganalyzer-uvicorn.log || true", shell=True, text=True)
    print(f"WATCHER_LOGS: {log_content.strip()}")
except Exception:
    print("WATCHER_LOGS: could not read")
