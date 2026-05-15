"""Backfill helper: enqueue historical events into the Elasticsearch outbox."""
from __future__ import annotations

import argparse
import asyncio
import uuid

from sqlalchemy import insert, select

from app.db.session import get_session_factory
from app.domain.models import Event, EventIndexOutbox


async def enqueue_historical_events(batch_size: int = 1000, max_rows: int | None = None) -> int:
    """Insert missing outbox rows for already stored events.

    Returns number of enqueued rows.
    """
    factory = get_session_factory()
    total_enqueued = 0

    async with factory() as session:
        while True:
            if max_rows is not None and total_enqueued >= max_rows:
                break

            remaining = None if max_rows is None else max_rows - total_enqueued
            effective_batch = min(batch_size, remaining) if remaining is not None else batch_size
            if effective_batch <= 0:
                break

            existing_subq = select(EventIndexOutbox.event_id)
            stmt = (
                select(Event.id)
                .where(Event.id.not_in(existing_subq))
                .order_by(Event.created_at.asc())
                .limit(effective_batch)
            )
            result = await session.execute(stmt)
            event_ids = [str(eid) for eid in result.scalars().all()]
            if not event_ids:
                break

            await session.execute(
                insert(EventIndexOutbox),
                [
                    {
                        "id": str(uuid.uuid4()),
                        "event_id": event_id,
                        "payload_json": {},
                        "attempts": 0,
                    }
                    for event_id in event_ids
                ],
            )
            await session.commit()
            total_enqueued += len(event_ids)

    return total_enqueued


async def _main() -> None:
    parser = argparse.ArgumentParser(description="Enqueue historical events for Elasticsearch indexing")
    parser.add_argument("--batch-size", type=int, default=1000)
    parser.add_argument("--max-rows", type=int, default=None)
    args = parser.parse_args()

    enqueued = await enqueue_historical_events(
        batch_size=max(1, args.batch_size),
        max_rows=args.max_rows,
    )
    print({"enqueued": enqueued})


if __name__ == "__main__":
    asyncio.run(_main())
