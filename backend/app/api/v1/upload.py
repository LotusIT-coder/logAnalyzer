"""File upload + Ollama analysis endpoint.

Accepts a multipart log file, parses up to 500 lines,
sends a condensed summary to Ollama for analysis, returns the result.
"""
from __future__ import annotations

import io
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.ollama_client import generate
from app.dependencies import get_db
from app.domain.models import Source
from app.ingestion.file_reader import ingest_source
from app.parser.pipeline import parse_line
from app.services.source_status import refresh_source_status

router = APIRouter(prefix="/upload", tags=["Upload"])

_MAX_LINES = 500
_MAX_UPLOAD_BYTES = 25 * 1024 * 1024
_UPLOAD_DIR = Path(__file__).resolve().parents[3] / "data" / "uploads"
_DEFAULT_MODEL = "qwen3.5:9b"
_DEFAULT_SYSTEM = (
    "You are a log analysis expert. Analyse the provided log lines and give a concise summary "
    "of key events, errors, warnings and anomalies. Respond in the same language the user uses."
)


class UploadAnalyzeResponse(BaseModel):
    lines_parsed: int
    events_found: int
    model: str
    analysis: str


class UploadImportResponse(BaseModel):
    source_id: str
    source_name: str
    stored_path: str
    lines_ingested: int
    events_created: int


def _sanitize_filename(name: str) -> str:
    base = Path(name).name or "upload.log"
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._")
    return safe or "upload.log"


@router.post("/analyze", response_model=UploadAnalyzeResponse, summary="Upload and analyze file")
async def upload_and_analyze(
    file: UploadFile = File(...),
    model: str = Form(default=_DEFAULT_MODEL),
    custom_prompt: Optional[str] = Form(default=None),
) -> UploadAnalyzeResponse:
    """Upload a log file and get an AI analysis from Ollama."""
    if file.content_type and "text" not in file.content_type and file.content_type != "application/octet-stream":
        raise HTTPException(status_code=415, detail="Only plain text log files are supported.")

    raw_bytes = await file.read()
    if len(raw_bytes) > 10 * 1024 * 1024:  # 10 MB cap
        raise HTTPException(status_code=413, detail="File too large (max 10 MB).")

    try:
        content = raw_bytes.decode("utf-8", errors="replace")
    except Exception:
        raise HTTPException(status_code=400, detail="Could not decode file as UTF-8.")
    del raw_bytes  # release the raw bytes buffer; only the decoded string is needed

    lines = [l.rstrip("\r\n") for l in io.StringIO(content) if l.strip()]
    del content  # release full decoded string; only the split lines are needed
    sampled = lines[:_MAX_LINES]

    # Try to parse structured events
    events: list[dict] = []
    for line in sampled:
        parsed = (
            parse_line(line, "json", None, None)
            or parse_line(line, "kv", None, None)
        )
        if parsed:
            events.append(parsed)

    # Build prompt
    log_block = "\n".join(sampled[:200])  # limit tokens
    user_prompt = custom_prompt or (
        f"Analysiere diese Log-Datei ({len(lines)} Zeilen gesamt, {len(events)} strukturierte Events erkannt). "
        f"Gib eine kompakte Zusammenfassung der wichtigsten Ereignisse, Fehler und Auffälligkeiten:\n\n"
        f"```\n{log_block}\n```"
    )

    try:
        analysis = await generate(
            model=model,
            prompt=user_prompt,
            system=_DEFAULT_SYSTEM,
            temperature=0.2,
            max_tokens=2048,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Ollama error: {exc}")

    return UploadAnalyzeResponse(
        lines_parsed=len(sampled),
        events_found=len(events),
        model=model,
        analysis=analysis,
    )


@router.post("/import", response_model=UploadImportResponse, summary="Upload and import file")
async def upload_and_import(
    file: UploadFile = File(...),
    source_name: Optional[str] = Form(default=None),
    session: AsyncSession = Depends(get_db),
) -> UploadImportResponse:
    """Upload a file and ingest it into raw_log/event for normal investigation workflows."""
    if file.content_type and "text" not in file.content_type and file.content_type != "application/octet-stream":
        raise HTTPException(status_code=415, detail="Only plain text log files are supported.")

    raw_bytes = await file.read()
    if len(raw_bytes) > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 25 MB).")

    safe_name = _sanitize_filename(file.filename or "upload.log")
    _UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}_{safe_name}"
    stored_path = _UPLOAD_DIR / stored_name
    stored_path.write_bytes(raw_bytes)
    del raw_bytes  # file is on disk; release the in-memory buffer

    source = Source(
        name=(source_name.strip() if source_name and source_name.strip() else f"Upload: {safe_name}"),
        type="file",
        config_json={"path": str(stored_path)},
        enabled=True,
    )
    session.add(source)
    await session.flush()
    await session.refresh(source)

    stats = await ingest_source(session, source)
    if stats.get("skipped"):
        raise HTTPException(status_code=400, detail=stats.get("reason", "Upload ingest failed."))
    await refresh_source_status(session, str(source.id), touched_at=datetime.now(timezone.utc))

    return UploadImportResponse(
        source_id=source.id,
        source_name=source.name,
        stored_path=str(stored_path),
        lines_ingested=int(stats.get("lines_ingested", 0)),
        events_created=int(stats.get("events_created", 0)),
    )
