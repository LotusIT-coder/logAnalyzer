"""Continuous file-watcher ingestion service.

The WatcherService runs as a background asyncio task that periodically polls
all enabled file sources and calls ingest_source() for each one.

Design goals:
- Single asyncio task (no threads, no watchdog inotify for now)
- Configurable poll interval (default: 5 seconds)
- Per-source error isolation: one failing source never crashes the loop
- Clean start/stop lifecycle usable from FastAPI lifespan
- tick_count exposed for testability
"""
from __future__ import annotations

import asyncio
import logging

import structlog

from app.db.session import get_session_factory
from app.ingestion.file_reader import ingest_source
from app.services.source_service import list_sources

logger = structlog.get_logger(__name__)


class WatcherService:
    """Async background service that polls log sources on a fixed interval."""

    def __init__(self, interval_seconds: float = 5.0) -> None:
        self.interval_seconds = interval_seconds
        self._task: asyncio.Task | None = None
        self.tick_count: int = 0

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(self) -> None:
        """Start the polling loop (idempotent)."""
        if self.running:
            return
        self._task = asyncio.create_task(self._loop(), name="ingestion-watcher")
        logger.info("watcher_started", interval_seconds=self.interval_seconds)

    async def stop(self) -> None:
        """Stop the polling loop gracefully."""
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        logger.info("watcher_stopped")

    async def _loop(self) -> None:
        """Main polling loop: runs until cancelled."""
        while True:
            await self._tick()
            self.tick_count += 1
            await asyncio.sleep(self.interval_seconds)

    async def _tick(self) -> None:
        """One ingestion cycle: open a session, list sources, ingest each."""
        factory = get_session_factory()
        async with factory() as session:
            try:
                sources = await list_sources(session)
            except Exception:
                logger.exception("watcher_list_sources_failed")
                return

            for source in sources:
                if not source.enabled:
                    continue
                try:
                    stats = await ingest_source(session, source)
                    if stats.get("lines_ingested", 0) or stats.get("events_created", 0):
                        logger.info(
                            "watcher_tick_ingested",
                            source_id=source.id,
                            **{k: v for k, v in stats.items() if k != "source_id"},
                        )
                except Exception:
                    logger.exception("watcher_source_error", source_id=source.id)

            try:
                await session.commit()
            except Exception:
                logger.exception("watcher_commit_failed")
                await session.rollback()


# Module-level singleton — imported by main.py lifespan
_watcher: WatcherService | None = None


def get_watcher() -> WatcherService:
    global _watcher
    if _watcher is None:
        _watcher = WatcherService()
    return _watcher
