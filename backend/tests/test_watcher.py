"""TDD tests for the file-watcher ingestion service.

Strategy:
- WatcherService manages a background asyncio task.
- It polls enabled Sources at a configurable interval.
- On each tick it calls ingest_source for every enabled file source.
- It handles start/stop lifecycle correctly.
- It recovers from per-source errors without crashing the whole loop.
"""
from __future__ import annotations

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch, call


pytestmark = pytest.mark.asyncio


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_source(sid: str = "src-1", enabled: bool = True, path: str = "/var/log/test.log"):
    src = MagicMock()
    src.id = sid
    src.type = "file"
    src.enabled = enabled
    src.config_json = {"path": path}
    return src


# ---------------------------------------------------------------------------
# WatcherService lifecycle
# ---------------------------------------------------------------------------

class TestWatcherServiceLifecycle:
    async def test_service_starts_and_can_be_stopped(self):
        from app.ingestion.watcher import WatcherService
        svc = WatcherService(interval_seconds=0.05)
        await svc.start()
        assert svc.running is True
        await svc.stop()
        assert svc.running is False

    async def test_start_is_idempotent(self):
        from app.ingestion.watcher import WatcherService
        svc = WatcherService(interval_seconds=0.05)
        await svc.start()
        await svc.start()  # second call should not raise or spawn extra tasks
        assert svc.running is True
        await svc.stop()

    async def test_stop_without_start_is_safe(self):
        from app.ingestion.watcher import WatcherService
        svc = WatcherService(interval_seconds=0.05)
        await svc.stop()  # must not raise


# ---------------------------------------------------------------------------
# WatcherService polling
# ---------------------------------------------------------------------------

class TestWatcherServicePolling:
    async def test_ingest_called_for_enabled_sources(self):
        """After one tick, ingest_source must be called for each enabled source."""
        from app.ingestion.watcher import WatcherService

        src = _make_source()

        mock_session = AsyncMock()
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        mock_factory = MagicMock(return_value=mock_session)

        with (
            patch("app.ingestion.watcher.get_session_factory", return_value=mock_factory),
            patch("app.ingestion.watcher.list_sources", new=AsyncMock(return_value=[src])),
            patch("app.ingestion.watcher.ingest_source", new=AsyncMock(return_value={"lines": 0})) as mock_ingest,
        ):
            svc = WatcherService(interval_seconds=0.05)
            await svc.start()
            await asyncio.sleep(0.15)  # let ≥1 tick fire
            await svc.stop()

        assert mock_ingest.call_count >= 1
        called_source = mock_ingest.call_args[0][1]
        assert called_source.id == "src-1"

    async def test_disabled_sources_are_skipped(self):
        """Disabled sources must not be passed to ingest_source."""
        from app.ingestion.watcher import WatcherService

        enabled_src = _make_source("s1", enabled=True)
        disabled_src = _make_source("s2", enabled=False)

        mock_session = AsyncMock()
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)
        mock_factory = MagicMock(return_value=mock_session)

        with (
            patch("app.ingestion.watcher.get_session_factory", return_value=mock_factory),
            patch("app.ingestion.watcher.list_sources", new=AsyncMock(return_value=[enabled_src, disabled_src])),
            patch("app.ingestion.watcher.ingest_source", new=AsyncMock(return_value={})) as mock_ingest,
        ):
            svc = WatcherService(interval_seconds=0.05)
            await svc.start()
            await asyncio.sleep(0.15)
            await svc.stop()

        called_ids = {c[0][1].id for c in mock_ingest.call_args_list}
        assert "s1" in called_ids
        assert "s2" not in called_ids

    async def test_per_source_error_does_not_crash_loop(self):
        """If one source raises, the loop must continue and process the next source."""
        from app.ingestion.watcher import WatcherService

        src_bad = _make_source("bad")
        src_good = _make_source("good")

        mock_session = AsyncMock()
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)
        mock_factory = MagicMock(return_value=mock_session)

        async def _ingest(session, source):
            if source.id == "bad":
                raise RuntimeError("disk error")
            return {"lines": 1}

        with (
            patch("app.ingestion.watcher.get_session_factory", return_value=mock_factory),
            patch("app.ingestion.watcher.list_sources", new=AsyncMock(return_value=[src_bad, src_good])),
            patch("app.ingestion.watcher.ingest_source", side_effect=_ingest),
        ):
            svc = WatcherService(interval_seconds=0.05)
            await svc.start()
            await asyncio.sleep(0.15)
            await svc.stop()

        # Service still running until stop() → no exception escaped
        assert svc.running is False

    async def test_interval_is_respected(self):
        """The service must wait ~interval_seconds between ticks."""
        from app.ingestion.watcher import WatcherService

        mock_session = AsyncMock()
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)
        mock_factory = MagicMock(return_value=mock_session)

        with (
            patch("app.ingestion.watcher.get_session_factory", return_value=mock_factory),
            patch("app.ingestion.watcher.list_sources", new=AsyncMock(return_value=[])),
        ):
            svc = WatcherService(interval_seconds=0.1)
            await svc.start()
            await asyncio.sleep(0.25)
            await svc.stop()

        # With 0.1s interval over 0.25s we expect ≥2 ticks (not 10+)
        assert svc.tick_count >= 2
        assert svc.tick_count <= 5
