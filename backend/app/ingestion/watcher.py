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
from datetime import datetime, timedelta, timezone

import structlog
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.db.session import get_session_factory
from app.domain.models import Event, SourceIngestionStatus
from app.ingestion.file_reader import ingest_source
from app.services.source_service import list_sources

logger = structlog.get_logger(__name__)

# Hard cap on the total number of lines ingested across ALL sources in a single
# tick. Prevents a burst of log data from many sources simultaneously from
# exhausting memory before the batch can be flushed and released.
_MAX_LINES_TOTAL_PER_TICK = 50_000
_PARSE_ERROR_WINDOW = timedelta(hours=1)


async def _refresh_source_status(session, source_id: str, touched_at: datetime) -> None:
    one_minute_ago = touched_at - timedelta(minutes=1)
    one_hour_ago = touched_at - _PARSE_ERROR_WINDOW

    last_event_timestamp_result = await session.execute(
        select(Event.timestamp)
        .where(Event.source_id == source_id)
        .order_by(Event.timestamp.desc())
        .limit(1)
    )
    last_event_timestamp = last_event_timestamp_result.scalar_one_or_none()

    last_event_created_result = await session.execute(
        select(Event.created_at)
        .where(Event.source_id == source_id)
        .order_by(Event.created_at.desc())
        .limit(1)
    )
    last_event_created_at = last_event_created_result.scalar_one_or_none()

    events_per_min_result = await session.execute(
        select(func.count(Event.id)).where(
            Event.source_id == source_id,
            Event.timestamp >= one_minute_ago,
        )
    )
    events_per_min = int(events_per_min_result.scalar_one() or 0)

    parse_error_count_result = await session.execute(
        select(func.count(Event.id)).where(
            Event.source_id == source_id,
            Event.timestamp >= one_hour_ago,
            Event.fields_json.contains({"ingest_parse_error": True}),
        )
    )
    parse_error_count = int(parse_error_count_result.scalar_one() or 0)

    upsert_stmt = pg_insert(SourceIngestionStatus).values(
        source_id=source_id,
        last_ingested_at=touched_at,
        last_event_timestamp=last_event_timestamp,
        last_event_created_at=last_event_created_at,
        last_seen_at=last_event_timestamp,
        events_per_min=events_per_min,
        parse_error_count=parse_error_count,
        updated_at=touched_at,
    )
    upsert_stmt = upsert_stmt.on_conflict_do_update(
        index_elements=[SourceIngestionStatus.source_id],
        set_={
            "last_ingested_at": touched_at,
            "last_event_timestamp": last_event_timestamp,
            "last_event_created_at": last_event_created_at,
            "last_seen_at": last_event_timestamp,
            "events_per_min": events_per_min,
            "parse_error_count": parse_error_count,
            "updated_at": touched_at,
        },
    )
    await session.execute(upsert_stmt)


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
            tick_now = datetime.now(timezone.utc)
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
                    await _refresh_source_status(session, str(source.id), touched_at=tick_now)
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
