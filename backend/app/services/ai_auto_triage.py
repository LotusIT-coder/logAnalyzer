"""Auto-triage helpers for newly created incidents."""
from __future__ import annotations

import asyncio
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import job_store, ollama_client
from app.db.session import get_session_factory
from app.domain.models import AIAnalysis, Incident

AUTO_TRIAGE_SESSION_KEY = "pending_ai_auto_triage_incident_ids"
AUTO_TRIAGE_EVENT_TOPIC = "ai.auto_triage.requested"
_DEFAULT_MODEL = "llama3"
_DEFAULT_SYSTEM = (
    "You are a senior incident responder. Summarize the incident, identify likely root causes, "
    "and propose the next remediation steps. Be concise and actionable."
)

_auto_triage_event_bus: Any | None = None


def configure_auto_triage_event_bus(event_bus: Any | None) -> None:
    """Set or clear the optional in-memory event bus used for auto-triage jobs."""
    global _auto_triage_event_bus
    _auto_triage_event_bus = event_bus


def mark_incident_for_auto_triage(session: AsyncSession, incident_id: str) -> None:
    pending = session.info.setdefault(AUTO_TRIAGE_SESSION_KEY, [])
    if incident_id not in pending:
        pending.append(incident_id)


def consume_incidents_marked_for_auto_triage(session: AsyncSession) -> list[str]:
    return list(session.info.pop(AUTO_TRIAGE_SESSION_KEY, []))


async def _run_auto_triage_job(job_id: str, incident_id: str) -> None:
    job_store.set_running(job_id)
    try:
        factory = get_session_factory()
        async with factory() as session:
            result = await session.execute(select(Incident).where(Incident.id == incident_id))
            incident = result.scalar_one_or_none()
            if incident is None:
                job_store.set_failed(job_id, "Incident not found.")
                return

            prompt = (
                f"Analyze this incident for triage:\n"
                f"Title: {incident.title}\n"
                f"Status: {incident.status}\n"
                f"Severity: {incident.severity}\n"
                f"First seen: {incident.first_seen.isoformat()}\n"
                f"Last seen: {incident.last_seen.isoformat()}\n"
                f"Event count: {incident.event_count}\n"
                f"Summary: {incident.summary or 'N/A'}\n"
            )

            answer = await ollama_client.generate(
                _DEFAULT_MODEL,
                prompt,
                _DEFAULT_SYSTEM,
                0.2,
                1024,
            )

            analysis = AIAnalysis(
                target_type="incident",
                target_ref=incident_id,
                model_name=_DEFAULT_MODEL,
                prompt_version="auto-triage-v1",
                result_text=answer,
            )
            session.add(analysis)
            await session.commit()

        job_store.set_completed(job_id, {"summary": answer})
    except Exception as exc:
        job_store.set_failed(job_id, str(exc))


async def _handle_auto_triage_requested(payload: dict[str, Any]) -> None:
    job_id = str(payload.get("job_id") or "").strip()
    incident_id = str(payload.get("incident_id") or "").strip()
    if not job_id or not incident_id:
        return
    await _run_auto_triage_job(job_id, incident_id)


def enqueue_auto_triage_for_incident(incident_id: str) -> str:
    job_id = job_store.create_job()
    if _auto_triage_event_bus is not None:
        asyncio.create_task(
            _auto_triage_event_bus.publish(
                AUTO_TRIAGE_EVENT_TOPIC,
                {"job_id": job_id, "incident_id": incident_id},
            )
        )
    else:
        asyncio.create_task(_run_auto_triage_job(job_id, incident_id))
    return job_id