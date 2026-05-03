"""In-memory async AI job store (MVP – single process, no persistence).

Jobs are stored in a module-level dict. FastAPI's background tasks run the
actual Ollama calls asynchronously after the HTTP response is returned (202).
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, Optional


# job_id -> {"id", "status", "result", "error"}
_jobs: Dict[str, Dict[str, Any]] = {}


def create_job() -> str:
    job_id = str(uuid.uuid4())
    _jobs[job_id] = {"id": job_id, "status": "queued", "result": None, "error": None}
    return job_id


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    return _jobs.get(job_id)


def set_running(job_id: str) -> None:
    if job_id in _jobs:
        _jobs[job_id]["status"] = "running"


def set_completed(job_id: str, result: Any) -> None:
    if job_id in _jobs:
        _jobs[job_id]["status"] = "completed"
        _jobs[job_id]["result"] = result


def set_failed(job_id: str, error: str) -> None:
    if job_id in _jobs:
        _jobs[job_id]["status"] = "failed"
        _jobs[job_id]["error"] = error
