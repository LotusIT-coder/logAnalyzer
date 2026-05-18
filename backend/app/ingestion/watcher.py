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
from datetime import datetime, timezone

import structlog

from app.db.session import get_session_factory
from app.ingestion.file_reader import ingest_source
from app.services.source_status import refresh_source_status
from app.services.source_service import list_sources

logger = structlog.get_logger(__name__)

# Hard cap on the total number of lines ingested across ALL sources in a single
# tick. Prevents a burst of log data from many sources simultaneously from
# exhausting memory before the batch can be flushed and released.
_MAX_LINES_TOTAL_PER_TICK = 10_000
_SOURCE_INGEST_TIMEOUT_SECONDS = 5.0
_REALTIME_SOURCE_INGEST_TIMEOUT_SECONDS = 20.0
_LOW_PRIORITY_SOURCES_PER_TICK = 1
_REALTIME_SOURCE_NAMES = {"syslog", "auth.log", "kern.log", "tuxguard", "tuxguard_error"}
_REALTIME_PATH_HINTS = {"/var/log/tuxguard/"}


class WatcherService:
    """Async background service that polls log sources on a fixed interval.

    Implements an adaptive "catch-up" loop: when the previous tick produced
    data (i.e. lines were ingested), the next tick fires after only
    ``catchup_min_sleep_seconds`` instead of the full ``interval_seconds``.
    That keeps the dashboard fresh during bursts while idling cheaply when
    nothing new arrives.
    """

    def __init__(
        self,
        interval_seconds: float = 1.0,
        catchup_min_sleep_seconds: float = 0.05,
    ) -> None:
        self.interval_seconds = interval_seconds
        self.catchup_min_sleep_seconds = catchup_min_sleep_seconds
        self._task: asyncio.Task | None = None
        self.tick_count: int = 0
        self._tick_running: bool = False  # backpressure guard
        self._last_tick_lines: int = 0
        self._low_priority_rr_index: int = 0

    @staticmethod
    def _is_realtime_source(source) -> bool:
        if source.type == "journald":
            return True
        source_name = (source.name or "").lower()
        if source_name in _REALTIME_SOURCE_NAMES:
            return True
        config = source.config_json if isinstance(source.config_json, dict) else {}
        source_path = str(config.get("path") or "").lower()
        return any(hint in source_path for hint in _REALTIME_PATH_HINTS)

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
        """Main polling loop: runs until cancelled.

        Sleeps ``catchup_min_sleep_seconds`` after productive ticks (any lines
        ingested) and the full ``interval_seconds`` when nothing happened.
        """
        while True:
            await self._tick()
            self.tick_count += 1
            if self._last_tick_lines > 0:
                await asyncio.sleep(self.catchup_min_sleep_seconds)
            else:
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

            realtime_sources = [source for source in sources if self._is_realtime_source(source)]
            low_priority_sources = [source for source in sources if not self._is_realtime_source(source)]
            # Keep near-real-time sources on every tick. Process only a small,
            # rotating slice of low-priority sources per tick so one long tick
            # cannot delay the next realtime pass by many seconds.
            selected_low_priority: list = []
            if low_priority_sources and _LOW_PRIORITY_SOURCES_PER_TICK > 0:
                start = self._low_priority_rr_index % len(low_priority_sources)
                for i in range(min(_LOW_PRIORITY_SOURCES_PER_TICK, len(low_priority_sources))):
                    selected_low_priority.append(low_priority_sources[(start + i) % len(low_priority_sources)])
                self._low_priority_rr_index = (start + len(selected_low_priority)) % len(low_priority_sources)

            ordered_sources = realtime_sources + selected_low_priority

            total_lines = 0
            self._last_tick_lines = 0
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
                    source_timeout = (
                        _REALTIME_SOURCE_INGEST_TIMEOUT_SECONDS
                        if self._is_realtime_source(source)
                        else _SOURCE_INGEST_TIMEOUT_SECONDS
                    )
                    # Guard every source ingestion so one blocking source
                    # cannot freeze the whole watcher tick indefinitely.
                    stats = await asyncio.wait_for(
                        ingest_source(session, source),
                        timeout=source_timeout,
                    )
                    # Use per-source timestamps so status freshness reflects the
                    # actual processing time within a potentially long tick.
                    await refresh_source_status(session, str(source.id), touched_at=datetime.now(timezone.utc))
                    ingested = stats.get("lines_ingested", 0)
                    total_lines += ingested
                    if ingested or stats.get("events_created", 0):
                        logger.info(
                            "watcher_tick_ingested",
                            source_id=source.id,
                            **{k: v for k, v in stats.items() if k != "source_id"},
                        )
                    try:
                        await session.commit()
                    except Exception:
                        logger.exception("watcher_commit_failed", source_id=source.id)
                        await session.rollback()
                except asyncio.TimeoutError:
                    logger.warning(
                        "watcher_source_timeout",
                        source_id=source.id,
                        timeout_seconds=source_timeout,
                    )
                    await session.rollback()
                except Exception:
                    logger.exception("watcher_source_error", source_id=source.id)
                    await session.rollback()

            self._last_tick_lines = total_lines
