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

import structlog

from app.db.session import get_session_factory
from app.ingestion.file_reader import ingest_source
from app.services.source_service import list_sources

logger = structlog.get_logger(__name__)

# Hard cap on the total number of lines ingested across ALL sources in a single
# tick. Prevents a burst of log data from many sources simultaneously from
# exhausting memory before the batch can be flushed and released.
_MAX_LINES_TOTAL_PER_TICK = 50_000


class WatcherService:
    """Async background service that polls log sources on a fixed interval."""

    def __init__(self, interval_seconds: float = 5.0) -> None:
        self.interval_seconds = interval_seconds
        self._task: asyncio.Task | None = None
        self.tick_count: int = 0
        self._tick_running: bool = False  # backpressure guard

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
        if self._tick_running:
            logger.warning("watcher_tick_skipped", reason="previous_tick_still_running")
            return
        self._tick_running = True
        try:
            await self._do_tick()
        finally:
            self._tick_running = False

    async def _do_tick(self) -> None:
        """Inner tick logic (called only when no tick is already in progress)."""
        factory = get_session_factory()
        async with factory() as session:
            try:
                sources = await list_sources(session)
            except Exception:
                logger.exception("watcher_list_sources_failed")
                return

            # Process journald first so near-real-time system events stay fresh
            # even when other sources have a large backlog.
            ordered_sources = sorted(
                sources,
                key=lambda source: (0 if source.type == "journald" else 1),
            )

            total_lines = 0
            for source in ordered_sources:
                if not source.enabled:
                    continue
                if total_lines >= _MAX_LINES_TOTAL_PER_TICK:
                    logger.warning(
                        "watcher_tick_global_limit_reached",
                        limit=_MAX_LINES_TOTAL_PER_TICK,
                        remaining_sources=sum(1 for s in ordered_sources if s.enabled),
                    )
                    break
                try:
                    stats = await ingest_source(session, source)
                    ingested = stats.get("lines_ingested", 0)
                    total_lines += ingested
                    if ingested or stats.get("events_created", 0):
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
