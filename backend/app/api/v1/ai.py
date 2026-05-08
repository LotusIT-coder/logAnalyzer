"""AI endpoints – models, analyze/window, analyze/incident, chat, jobs/{id}."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from typing import Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import job_store, ollama_client
from app.config import get_settings
from app.dependencies import get_db
from app.domain.models import AIAnalysis, Event, Incident, ModelProfile
from app.schemas.domain import (
    AIAnalyzeIncidentRequest,
    AIAnalyzeWindowRequest,
    AIChatRequest,
    AIChatAsyncRequest,
    AIChatResponse,
    AIJob,
    AIModelListResponse,
    AIModelResponse,
    AsyncJobAccepted,
)

router = APIRouter(prefix="/ai", tags=["AI"])

_DEFAULT_MODEL = "llama3"
_DEFAULT_SYSTEM = (
    "You are a senior site-reliability engineer analyzing log events. "
    "Be concise, factual, and actionable. Respond in the same language as the logs."
)

_STOP_WORDS = {
    # English
    'the','a','an','is','are','was','were','in','on','at','to','for','of','and','or',
    'not','with','from','that','this','what','when','where','how','why','which','who',
    'my','all','any','some','no','be','have','do','can','will','would','could','should',
    'may','might','log','logs','event','events','show','find','list','get','tell','me',
    'about','please',
    # German
    'ich','die','der','das','ein','eine','ist','sind','war','für','von','mit','aus',
    'bei','zeig','zeige','finde','was','wie','wann','warum','welche','welcher','welches',
    'alle','meine','bitte','gibt','es','im','den','dem','des','nach','sich','auch','noch',
    'nur','dann','wenn','aber','oder','und','nicht','sehr','mehr','als','schau','zeige',
}


def _extract_keywords(text: str) -> list[str]:
    """Extract meaningful keywords from a natural-language query."""
    import re
    words = re.split(r'[\s,;:!?.()\[\]{}"\']+', text.lower())
    seen: dict[str, None] = {}
    for w in words:
        if len(w) >= 4 and w not in _STOP_WORDS:
            seen[w] = None
    return list(seen.keys())


def _augment_message(message: str, context: dict | None, references: list[str]) -> str:
    parts = [message]
    if context:
        parts.append(
            "Structured application context:\n"
            + json.dumps(context, ensure_ascii=False, indent=2, default=str)
        )
    if references:
        parts.append(
            "Relevant log events from the database:\n"
            + "\n".join(references[:10])
        )
    return "\n\n".join(parts)


async def _get_model_settings(
    session: AsyncSession,
    model_profile_id: Optional[str],
) -> tuple[str, str, float, int]:
    """Return (ollama_model, system_prompt, temperature, max_tokens)."""
    if model_profile_id:
        result = await session.execute(
            select(ModelProfile).where(
                ModelProfile.id == model_profile_id,
                ModelProfile.enabled == True,  # noqa: E712
            )
        )
        profile = result.scalar_one_or_none()
        if profile is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Model profile not found or disabled.",
            )
        return (
            profile.ollama_model,
            profile.system_prompt_template,
            float(profile.temperature),
            profile.max_tokens,
        )
    settings = get_settings()
    return _DEFAULT_MODEL, _DEFAULT_SYSTEM, 0.2, 1024


# ---------------------------------------------------------------------------
# GET /ai/models
# ---------------------------------------------------------------------------

@router.get("/models", response_model=AIModelListResponse)
async def list_models():
    """Proxy Ollama /api/tags to list available local models."""
    try:
        raw = await ollama_client.list_models()
    except (httpx.ConnectError, httpx.HTTPError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Ollama is not reachable. Ensure it is running at the configured base URL.",
        )

    items = [
        AIModelResponse(
            name=m.get("name", ""),
            size=str(m.get("size", "")) if m.get("size") else None,
            family=m.get("details", {}).get("family"),
            modified_at=m.get("modified_at"),
        )
        for m in raw
    ]
    return AIModelListResponse(items=items)


# ---------------------------------------------------------------------------
# POST /ai/analyze/window
# ---------------------------------------------------------------------------

async def _run_window_analysis(
    job_id: str,
    db_url: str,
    from_dt: datetime,
    to_dt: datetime,
    model: str,
    system: str,
    temperature: float,
    max_tokens: int,
) -> None:
    """Background task: fetch events in window, call Ollama, persist AIAnalysis."""
    from app.db.session import get_session_factory

    job_store.set_running(job_id)
    try:
        factory = get_session_factory()
        async with factory() as session:
            stmt = (
                select(Event)
                .where(Event.timestamp >= from_dt, Event.timestamp <= to_dt)
                .order_by(Event.timestamp.asc())
                .limit(500)
            )
            result = await session.execute(stmt)
            events = result.scalars().all()

            if not events:
                job_store.set_completed(job_id, {"summary": "No events in the given time window."})
                return

            log_text = "\n".join(
                f"[{e.timestamp.isoformat()}] [{e.severity.upper()}] {e.message}"
                for e in events
            )
            prompt = (
                f"Analyze these {len(events)} log events from "
                f"{from_dt.isoformat()} to {to_dt.isoformat()}:\n\n{log_text}\n\n"
                "Summarize key issues, root causes, and recommended actions."
            )

            answer = await ollama_client.generate(model, prompt, system, temperature, max_tokens)

            analysis = AIAnalysis(
                target_type="window",
                target_ref=f"{from_dt.isoformat()}/{to_dt.isoformat()}",
                model_name=model,
                prompt_version="v1",
                result_text=answer,
            )
            session.add(analysis)
            await session.commit()

        job_store.set_completed(job_id, {"summary": answer})
    except Exception as exc:
        job_store.set_failed(job_id, str(exc))


@router.post("/analyze/window", response_model=AsyncJobAccepted, status_code=202)
async def analyze_window(
    body: AIAnalyzeWindowRequest,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
    settings=Depends(get_settings),
):
    model, system, temperature, max_tokens = await _get_model_settings(
        session, body.model_profile_id
    )
    job_id = job_store.create_job()
    background_tasks.add_task(
        _run_window_analysis,
        job_id,
        settings.database_url,
        body.from_,
        body.to,
        model,
        system,
        temperature,
        max_tokens,
    )
    return AsyncJobAccepted(job_id=job_id)


# ---------------------------------------------------------------------------
# POST /ai/analyze/incident/{id}
# ---------------------------------------------------------------------------

async def _run_incident_analysis(
    job_id: str,
    incident_id: str,
    model: str,
    system: str,
    temperature: float,
    max_tokens: int,
) -> None:
    from app.db.session import get_session_factory

    job_store.set_running(job_id)
    try:
        factory = get_session_factory()
        async with factory() as session:
            result = await session.execute(
                select(Incident).where(Incident.id == incident_id)
            )
            incident = result.scalar_one_or_none()
            if incident is None:
                job_store.set_failed(job_id, "Incident not found.")
                return

            prompt = (
                f"Analyze this incident:\n"
                f"Title: {incident.title}\n"
                f"Status: {incident.status}\n"
                f"Severity: {incident.severity}\n"
                f"First seen: {incident.first_seen.isoformat()}\n"
                f"Last seen: {incident.last_seen.isoformat()}\n"
                f"Event count: {incident.event_count}\n"
                f"Summary: {incident.summary or 'N/A'}\n\n"
                "Provide a root cause analysis and recommended remediation steps."
            )

            answer = await ollama_client.generate(model, prompt, system, temperature, max_tokens)

            analysis = AIAnalysis(
                target_type="incident",
                target_ref=incident_id,
                model_name=model,
                prompt_version="v1",
                result_text=answer,
            )
            session.add(analysis)
            await session.commit()

        job_store.set_completed(job_id, {"summary": answer})
    except Exception as exc:
        job_store.set_failed(job_id, str(exc))


@router.post("/analyze/incident/{incident_id}", response_model=AsyncJobAccepted, status_code=202)
async def analyze_incident(
    incident_id: str,
    background_tasks: BackgroundTasks,
    body: Optional[AIAnalyzeIncidentRequest] = None,
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(Incident).where(Incident.id == incident_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found.")

    model_profile_id = body.model_profile_id if body else None
    model, system, temperature, max_tokens = await _get_model_settings(session, model_profile_id)

    job_id = job_store.create_job()
    background_tasks.add_task(
        _run_incident_analysis,
        job_id,
        incident_id,
        model,
        system,
        temperature,
        max_tokens,
    )
    return AsyncJobAccepted(job_id=job_id)


# ---------------------------------------------------------------------------
# POST /ai/chat
# ---------------------------------------------------------------------------

@router.post("/chat", response_model=AIChatResponse)
async def ai_chat(
    body: AIChatRequest,
    session: AsyncSession = Depends(get_db),
):
    # --- Model resolution ---
    if body.model_profile_id:
        model, system, temperature, max_tokens = await _get_model_settings(
            session, body.model_profile_id
        )
    elif body.model:
        model = body.model
        system = _DEFAULT_SYSTEM
        temperature = 0.2
        max_tokens = 2048
    else:
        model, system, temperature, max_tokens = await _get_model_settings(session, None)

    # --- Fetch relevant log events as context ---
    references: list[str] = []
    keywords = _extract_keywords(body.message)
    augmented_message = body.message

    if keywords:
        conditions = [Event.message.ilike(f"%{kw}%") for kw in keywords[:4]]
        stmt = (
            select(Event)
            .where(or_(*conditions))
            .order_by(Event.timestamp.desc())
            .limit(20)
        )
        result = await session.execute(stmt)
        events = result.scalars().all()
        references = [
            f"[{e.timestamp.strftime('%Y-%m-%d %H:%M:%S')}] [{e.severity.upper()}] {e.message}"
            for e in events
        ]
    augmented_message = _augment_message(body.message, body.context, references)

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": augmented_message},
    ]

    try:
        answer = await ollama_client.chat(model, messages, temperature, max_tokens)
    except (httpx.ConnectError, httpx.HTTPError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Ollama error: {exc}",
        )

    return AIChatResponse(answer=answer, references=references[:10])


# ---------------------------------------------------------------------------
# POST /ai/chat/async
# ---------------------------------------------------------------------------

async def _run_chat_async(
    job_id: str,
    db_url: str,
    model: str,
    system: str,
    temperature: float,
    max_tokens: int,
    message: str,
    source_ids: list[str],
    source_paths: list[str],
    since_hours: float | None,
    context: dict | None,
) -> None:
    from app.db.session import get_session_factory

    job_store.set_running(job_id)
    try:
        factory = get_session_factory()
        async with factory() as session:
            keywords = _extract_keywords(message)
            references: list[str] = []
            augmented = message

            if keywords:
                from datetime import timedelta
                conditions = [Event.message.ilike(f"%{kw}%") for kw in keywords[:4]]
                stmt = select(Event).where(or_(*conditions))

                # Apply source filters
                if source_ids:
                    from sqlalchemy import cast
                    from sqlalchemy import String as SAString
                    stmt = stmt.where(cast(Event.source_id, SAString).in_(source_ids))
                if source_paths:
                    from app.domain.models import Source
                    sub = select(Source.id).where(
                        or_(*[Source.config_json["path"].astext == p for p in source_paths])
                    )
                    stmt = stmt.where(Event.source_id.in_(sub))
                if since_hours:
                    cutoff = datetime.now(timezone.utc) - timedelta(hours=since_hours)
                    stmt = stmt.where(Event.timestamp >= cutoff)

                stmt = stmt.order_by(Event.timestamp.desc()).limit(20)
                result = await session.execute(stmt)
                events = result.scalars().all()
                references = [
                    f"[{e.timestamp.strftime('%Y-%m-%d %H:%M:%S')}] [{e.severity.upper()}] {e.message}"
                    for e in events
                ]
            augmented = _augment_message(message, context, references)

        msgs = [
            {"role": "system", "content": system},
            {"role": "user", "content": augmented},
        ]
        answer = await ollama_client.chat(model, msgs, temperature, max_tokens)
        job_store.set_completed(job_id, {"answer": answer, "references": references[:10]})
    except Exception as exc:
        job_store.set_failed(job_id, str(exc))


@router.post("/chat/async", response_model=AsyncJobAccepted, status_code=202)
async def ai_chat_async(
    body: AIChatAsyncRequest,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
    settings=Depends(get_settings),
):
    if body.model_profile_id:
        model, system, temperature, max_tokens = await _get_model_settings(
            session, body.model_profile_id
        )
    elif body.model:
        model = body.model
        system = _DEFAULT_SYSTEM
        temperature = 0.2
        max_tokens = 2048
    else:
        model, system, temperature, max_tokens = await _get_model_settings(session, None)

    job_id = job_store.create_job()
    background_tasks.add_task(
        _run_chat_async,
        job_id,
        settings.database_url,
        model,
        system,
        temperature,
        max_tokens,
        body.message,
        body.source_ids or [],
        body.source_paths or [],
        body.since_hours,
        body.context,
    )
    return AsyncJobAccepted(job_id=job_id)


# ---------------------------------------------------------------------------
# GET /ai/jobs/{id}
# ---------------------------------------------------------------------------

@router.get("/jobs/{job_id}", response_model=AIJob)
async def get_job(job_id: str):
    job = job_store.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found.")
    return AIJob(**job)
