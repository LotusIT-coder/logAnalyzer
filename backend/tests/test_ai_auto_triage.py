"""Tests for AI auto-triage helpers."""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.ai import job_store
from app.domain.models import AIAnalysis, Incident
from app.services.ai_auto_triage import (
    _run_auto_triage_job,
    consume_incidents_marked_for_auto_triage,
    mark_incident_for_auto_triage,
)


@pytest.mark.asyncio
class TestAutoTriageBookkeeping:
    async def test_mark_and_consume_deduplicates_incident_ids(self):
        session = MagicMock()
        session.info = {}

        mark_incident_for_auto_triage(session, "inc-1")
        mark_incident_for_auto_triage(session, "inc-1")
        mark_incident_for_auto_triage(session, "inc-2")

        pending = consume_incidents_marked_for_auto_triage(session)

        assert pending == ["inc-1", "inc-2"]
        assert consume_incidents_marked_for_auto_triage(session) == []


@pytest.mark.asyncio
class TestAutoTriageRunner:
    async def test_run_auto_triage_job_persists_ai_analysis(self, engine, db_session: AsyncSession):
        job_store._jobs.clear()

        incident = Incident(
            title="Rule fired: SSH burst",
            status="open",
            severity="warning",
            first_seen=datetime.now(timezone.utc),
            last_seen=datetime.now(timezone.utc),
            event_count=5,
            summary="Failed password spike on sshd",
            tags_json=[],
        )
        db_session.add(incident)
        await db_session.commit()

        factory = async_sessionmaker(bind=engine, expire_on_commit=False, class_=AsyncSession)
        job_id = job_store.create_job()

        with (
            patch("app.services.ai_auto_triage.get_session_factory", return_value=factory),
            patch("app.services.ai_auto_triage.ollama_client.generate", new=AsyncMock(return_value="triage result")),
        ):
            await _run_auto_triage_job(job_id, incident.id)

        job = job_store.get_job(job_id)
        assert job is not None
        assert job["status"] == "completed"
        assert job["result"] == {"summary": "triage result"}

        result = await db_session.execute(select(AIAnalysis).where(AIAnalysis.target_ref == incident.id))
        analysis = result.scalar_one()
        assert analysis.target_type == "incident"
        assert analysis.prompt_version == "auto-triage-v1"
        assert analysis.result_text == "triage result"