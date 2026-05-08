"""In-memory async AI job store (MVP – single process, no persistence).

Jobs are stored in a module-level dict. FastAPI's background tasks run the
actual Ollama calls asynchronously after the HTTP response is returned (202).

Completed and failed jobs are evicted after _JOB_TTL_SECONDS (1 h) to prevent
unbounded memory growth when many analyses are triggered over time.
"""
from __future__ import annotations

import time
import uuid
from typing import Any, Dict, Optional


# job_id -> {"id", "status", "result", "error", "_ts"}
_jobs: Dict[str, Dict[str, Any]] = {}
_JOB_TTL_SECONDS = 3600  # evict completed/failed jobs after 1 hour


def _evict_stale_jobs() -> None:
    """Remove completed/failed jobs that are older than _JOB_TTL_SECONDS."""
    cutoff = time.monotonic() - _JOB_TTL_SECONDS
    stale = [
        jid
        for jid, j in _jobs.items()
        if j["status"] in ("completed", "failed") and j.get("_ts", 0) < cutoff
    ]
    for jid in stale:
        del _jobs[jid]


def create_job() -> str:
    _evict_stale_jobs()
    job_id = str(uuid.uuid4())
    _jobs[job_id] = {
        "id": job_id,
        "status": "queued",
        "result": None,
        "error": None,
        "_ts": time.monotonic(),
    }
    return job_id


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    job = _jobs.get(job_id)
    if job is None:
        return None
    # Return a copy without the internal bookkeeping field.
    return {k: v for k, v in job.items() if k != "_ts"}


def set_running(job_id: str) -> None:
    if job_id in _jobs:
        _jobs[job_id]["status"] = "running"
        _jobs[job_id]["_ts"] = time.monotonic()


def set_completed(job_id: str, result: Any) -> None:
    if job_id in _jobs:
        _jobs[job_id]["status"] = "completed"
        _jobs[job_id]["result"] = result
        _jobs[job_id]["_ts"] = time.monotonic()


def set_failed(job_id: str, error: str) -> None:
    if job_id in _jobs:
        _jobs[job_id]["status"] = "failed"
        _jobs[job_id]["error"] = error
        _jobs[job_id]["_ts"] = time.monotonic()
