"""Tests for the SOC Analyst Service."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.domain.models import Incident
from app.services.soc_analyst import (
    SOCAnalystService,
    _build_prompt,
    _map_severity,
    _pattern_hash,
    _run_analysis_tick,
)


# ---------------------------------------------------------------------------
# Unit tests – pure helpers
# ---------------------------------------------------------------------------

class TestHelpers:
    def test_map_severity_known_values(self):
        assert _map_severity("critical") == "critical"
        assert _map_severity("high") == "error"
        assert _map_severity("medium") == "warning"
        assert _map_severity("low") == "info"

    def test_map_severity_unknown_falls_back(self):
        assert _map_severity("extreme") == "warning"

    def test_pattern_hash_deterministic(self):
        h1 = _pattern_hash("brute_force_ssh", "SSH brute force detected")
        h2 = _pattern_hash("brute_force_ssh", "SSH brute force detected")
        assert h1 == h2
        assert len(h1) == 16

    def test_pattern_hash_different_for_different_inputs(self):
        h1 = _pattern_hash("brute_force_ssh", "SSH brute force detected")
        h2 = _pattern_hash("port_scan", "Port scan detected")
        assert h1 != h2

    def test_build_prompt_contains_events(self):
        events = [{"id": "1", "message": "failed login", "severity": "warning"}]
        prompt = _build_prompt(events)
        assert "failed login" in prompt
        assert "warning" in prompt


# ---------------------------------------------------------------------------
# Integration tests – _run_analysis_tick with mocked Ollama + DB
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
class TestRunAnalysisTick:

    async def test_no_events_skips_ollama(self, engine):
        """When no relevant events exist, Ollama should not be called."""
        session_factory = async_sessionmaker(engine, expire_on_commit=False)

        with patch("app.services.soc_analyst.get_session_factory", return_value=session_factory), \
             patch("app.services.soc_analyst.ollama_client.generate", new_callable=AsyncMock) as mock_gen:
            await _run_analysis_tick(
                model="llama3",
                window_events=100,
                confidence_threshold=0.7,
            )
            mock_gen.assert_not_called()

    async def test_no_threat_detected_creates_no_incident(self, engine):
        """When Ollama returns threat_detected=false, no incident is created."""
        from app.domain.models import Event, Source

        session_factory = async_sessionmaker(engine, expire_on_commit=False)

        # Seed a relevant event
        async with session_factory() as session:
            source = Source(name="test", type="file", config_json={})
            session.add(source)
            await session.flush()
            event = Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="error",
                message="disk full",
            )
            session.add(event)
            await session.commit()

        ollama_response = json.dumps({
            "threat_detected": False,
            "pattern_type": "",
            "severity": "low",
            "confidence": 0.0,
            "title": "",
            "summary": "",
        })

        with patch("app.services.soc_analyst.get_session_factory", return_value=session_factory), \
             patch("app.services.soc_analyst.ollama_client.generate",
                   new_callable=AsyncMock, return_value=ollama_response):
            await _run_analysis_tick(
                model="llama3",
                window_events=100,
                confidence_threshold=0.7,
            )

        async with session_factory() as session:
            result = await session.execute(select(Incident))
            assert result.scalars().all() == []

    async def test_high_confidence_threat_creates_incident(self, engine):
        """When Ollama returns a high-confidence threat, an Incident is created."""
        from app.domain.models import Event, Source

        session_factory = async_sessionmaker(engine, expire_on_commit=False)

        async with session_factory() as session:
            source = Source(name="test-src", type="file", config_json={})
            session.add(source)
            await session.flush()
            for i in range(5):
                session.add(Event(
                    source_id=source.id,
                    timestamp=datetime.now(timezone.utc),
                    severity="warning",
                    message=f"Failed SSH login attempt #{i}",
                ))
            await session.commit()

        ollama_response = json.dumps({
            "threat_detected": True,
            "pattern_type": "brute_force_ssh",
            "severity": "high",
            "confidence": 0.92,
            "title": "SSH Brute Force Detected",
            "summary": "Multiple failed SSH logins from the same host.",
        })

        with patch("app.services.soc_analyst.get_session_factory", return_value=session_factory), \
             patch("app.services.soc_analyst.ollama_client.generate",
                   new_callable=AsyncMock, return_value=ollama_response), \
             patch("app.services.soc_analyst.mark_incident_for_auto_triage"), \
             patch("app.services.soc_analyst.mark_incident_for_notification"):
            await _run_analysis_tick(
                model="llama3",
                window_events=100,
                confidence_threshold=0.7,
            )

        async with session_factory() as session:
            result = await session.execute(select(Incident))
            incidents = result.scalars().all()
            assert len(incidents) == 1
            inc = incidents[0]
            assert inc.title == "SSH Brute Force Detected"
            assert inc.severity == "error"  # mapped from "high"
            assert "ai_soc" in inc.tags_json

    async def test_below_confidence_threshold_creates_no_incident(self, engine):
        """Findings below the confidence threshold must not create incidents."""
        from app.domain.models import Event, Source

        session_factory = async_sessionmaker(engine, expire_on_commit=False)

        async with session_factory() as session:
            source = Source(name="src2", type="file", config_json={})
            session.add(source)
            await session.flush()
            session.add(Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="warning",
                message="suspicious activity",
            ))
            await session.commit()

        ollama_response = json.dumps({
            "threat_detected": True,
            "pattern_type": "port_scan",
            "severity": "medium",
            "confidence": 0.4,  # below 0.7 threshold
            "title": "Possible Port Scan",
            "summary": "Some ports were probed.",
        })

        with patch("app.services.soc_analyst.get_session_factory", return_value=session_factory), \
             patch("app.services.soc_analyst.ollama_client.generate",
                   new_callable=AsyncMock, return_value=ollama_response):
            await _run_analysis_tick(
                model="llama3",
                window_events=100,
                confidence_threshold=0.7,
            )

        async with session_factory() as session:
            result = await session.execute(select(Incident))
            assert result.scalars().all() == []

    async def test_deduplication_prevents_duplicate_incidents(self, engine):
        """A second tick with the same pattern must not create a second incident."""
        from app.domain.models import Event, Source

        session_factory = async_sessionmaker(engine, expire_on_commit=False)

        async with session_factory() as session:
            source = Source(name="src3", type="file", config_json={})
            session.add(source)
            await session.flush()
            session.add(Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="error",
                message="repeated error",
            ))
            await session.commit()

        ollama_response = json.dumps({
            "threat_detected": True,
            "pattern_type": "repeated_crash",
            "severity": "high",
            "confidence": 0.85,
            "title": "Service Crash Loop Detected",
            "summary": "A service is crashing repeatedly.",
        })

        with patch("app.services.soc_analyst.get_session_factory", return_value=session_factory), \
             patch("app.services.soc_analyst.ollama_client.generate",
                   new_callable=AsyncMock, return_value=ollama_response), \
             patch("app.services.soc_analyst.mark_incident_for_auto_triage"), \
             patch("app.services.soc_analyst.mark_incident_for_notification"):
            # First tick → creates incident
            await _run_analysis_tick("llama3", 100, 0.7)
            # Second tick → must be deduplicated
            await _run_analysis_tick("llama3", 100, 0.7)

        async with session_factory() as session:
            result = await session.execute(select(Incident))
            incidents = result.scalars().all()
            assert len(incidents) == 1  # still only one

    async def test_invalid_json_from_ollama_is_handled_gracefully(self, engine):
        """Unparseable Ollama responses must not crash the loop."""
        from app.domain.models import Event, Source

        session_factory = async_sessionmaker(engine, expire_on_commit=False)

        async with session_factory() as session:
            source = Source(name="src4", type="file", config_json={})
            session.add(source)
            await session.flush()
            session.add(Event(
                source_id=source.id,
                timestamp=datetime.now(timezone.utc),
                severity="error",
                message="something broke",
            ))
            await session.commit()

        with patch("app.services.soc_analyst.get_session_factory", return_value=session_factory), \
             patch("app.services.soc_analyst.ollama_client.generate",
                   new_callable=AsyncMock, return_value="not valid json at all"):
            # Should not raise
            await _run_analysis_tick("llama3", 100, 0.7)

        async with session_factory() as session:
            result = await session.execute(select(Incident))
            assert result.scalars().all() == []


# ---------------------------------------------------------------------------
# Service lifecycle tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
class TestSOCAnalystServiceLifecycle:

    async def test_start_stop(self):
        svc = SOCAnalystService(
            model="llama3",
            interval_seconds=999,
            confidence_threshold=0.7,
            window_events=50,
        )
        assert not svc.running
        await svc.start()
        assert svc.running
        # Idempotent start
        await svc.start()
        assert svc.running
        await svc.stop()
        assert not svc.running

    async def test_stop_without_start_is_noop(self):
        svc = SOCAnalystService("llama3", 999, 0.7, 50)
        await svc.stop()  # must not raise
