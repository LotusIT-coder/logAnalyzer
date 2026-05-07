"""Notification helpers for newly created incidents."""
from __future__ import annotations

import asyncio

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.session import get_session_factory
from app.domain.models import Incident

NOTIFICATION_SESSION_KEY = "pending_incident_notification_ids"


def mark_incident_for_notification(session: AsyncSession, incident_id: str) -> None:
    pending = session.info.setdefault(NOTIFICATION_SESSION_KEY, [])
    if incident_id not in pending:
        pending.append(incident_id)


def consume_incidents_marked_for_notification(session: AsyncSession) -> list[str]:
    return list(session.info.pop(NOTIFICATION_SESSION_KEY, []))


async def _send_incident_notification(incident_id: str) -> None:
    settings = get_settings()
    webhook_url = settings.notification_webhook_url
    if not webhook_url:
        return

    factory = get_session_factory()
    async with factory() as session:
        result = await session.execute(select(Incident).where(Incident.id == incident_id))
        incident = result.scalar_one_or_none()
        if incident is None:
            return

        payload = {
            "incident_id": incident.id,
            "title": incident.title,
            "status": incident.status,
            "severity": incident.severity,
            "first_seen": incident.first_seen.isoformat(),
            "last_seen": incident.last_seen.isoformat(),
            "event_count": incident.event_count,
            "summary": incident.summary,
            "tags": incident.tags_json,
        }

    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(webhook_url, json=payload)
        response.raise_for_status()


def enqueue_incident_notification(incident_id: str) -> None:
    asyncio.create_task(_send_incident_notification(incident_id))