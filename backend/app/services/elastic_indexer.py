"""Background worker to flush event indexing outbox to Elasticsearch."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import structlog
from sqlalchemy import select

from app.config import get_settings
from app.db.session import get_session_factory
from app.domain.models import Event, EventIndexOutbox
from app.services.elastic_client import ElasticClient


logger = structlog.get_logger(__name__)


def _to_index_doc(event: Event) -> dict:
    return {
        "event_id": str(event.id),
        "timestamp": event.timestamp.isoformat() if event.timestamp else None,
        "created_at": event.created_at.isoformat() if event.created_at else None,
        "severity": event.severity,
        "service": event.service,
        "host": event.host,
        "environment": event.environment,
        "event_type": event.event_type,
        "message": event.message,
        "source_id": str(event.source_id),
        "fingerprint": event.fingerprint,
        "fields_json": event.fields_json or {},
    }


class ElasticIndexerService:
    """Async outbox consumer for Elasticsearch indexing."""

    def __init__(self, interval_seconds: float = 5.0, batch_size: int = 500) -> None:
        self.interval_seconds = interval_seconds
        self.batch_size = batch_size
        self._task: asyncio.Task | None = None
        self.tick_count: int = 0

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(self) -> None:
        if self.running:
            return
        self._task = asyncio.create_task(self._loop(), name="elastic-indexer")
        logger.info("elastic_indexer_started", interval_seconds=self.interval_seconds, batch_size=self.batch_size)

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        logger.info("elastic_indexer_stopped")

    async def _loop(self) -> None:
        while True:
            await self._tick()
            self.tick_count += 1
            await asyncio.sleep(self.interval_seconds)

    async def _tick(self) -> None:
        settings = get_settings()
        if not settings.elastic_enabled or not settings.elastic_indexer_enabled:
            return

        elastic = ElasticClient.from_settings(settings)
        if not await elastic.ping():
            logger.warning("elastic_indexer_skip", reason="elastic_unreachable")
            return

        factory = get_session_factory()
        async with factory() as session:
            now = datetime.now(timezone.utc)
            pending_rows = await session.execute(
                select(EventIndexOutbox)
                .where(
                    EventIndexOutbox.processed_at.is_(None),
                    EventIndexOutbox.next_retry_at <= now,
                )
                .order_by(EventIndexOutbox.created_at.asc())
                .limit(self.batch_size)
                .with_for_update(skip_locked=True)
            )
            outbox_items = list(pending_rows.scalars().all())
            if not outbox_items:
                return

            event_ids = [item.event_id for item in outbox_items]
            events_result = await session.execute(select(Event).where(Event.id.in_(event_ids)))
            events_by_id = {str(event.id): event for event in events_result.scalars().all()}

            docs: list[dict] = []
            successful_item_ids: list[str] = []
            missing_event_item_ids: list[str] = []

            for item in outbox_items:
                event = events_by_id.get(str(item.event_id))
                if event is None:
                    missing_event_item_ids.append(str(item.id))
                    continue
                docs.append(_to_index_doc(event))
                successful_item_ids.append(str(item.id))

            success_count = 0
            error_count = 0
            if docs:
                success_count, error_count = await elastic.bulk_index_events(
                    index_name=settings.elastic_index_name,
                    docs=docs,
                )

            # Mark items without backing events as processed (event might have been deleted).
            for item in outbox_items:
                if str(item.id) in missing_event_item_ids:
                    item.processed_at = now
                    item.last_error = "event_missing"

            if success_count and not error_count:
                for item in outbox_items:
                    if str(item.id) in successful_item_ids:
                        item.processed_at = now
                        item.last_error = None
            elif docs:
                # Bulk failure path: backoff all attempted rows together.
                max_retries = max(1, settings.elastic_indexer_max_retries)
                for item in outbox_items:
                    if str(item.id) not in successful_item_ids:
                        continue
                    item.attempts = int(item.attempts or 0) + 1
                    backoff = min(2 ** min(item.attempts, 8), 300)
                    item.next_retry_at = now + timedelta(seconds=backoff)
                    if item.attempts >= max_retries:
                        item.processed_at = now
                        item.last_error = "max_retries_exceeded"
                    else:
                        item.last_error = "elastic_bulk_failed"

            await session.commit()
            logger.info(
                "elastic_indexer_tick",
                dequeued=len(outbox_items),
                docs_attempted=len(docs),
                success=success_count,
                errors=error_count,
            )
