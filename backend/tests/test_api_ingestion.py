from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.models import Source, SourceIngestionStatus


pytestmark = pytest.mark.asyncio


async def test_manual_ingestion_refreshes_source_status_immediately(
    client: AsyncClient,
    db_session: AsyncSession,
    tmp_path,
):
    log_path = tmp_path / "manual-ingest.log"
    log_path.write_text('{"timestamp":"2026-05-01T10:00:00Z","severity":"info","message":"manual ingest"}\n', encoding="utf-8")

    source = Source(
        name="manual-ingest-source",
        type="file",
        config_json={"path": str(log_path)},
        enabled=True,
    )
    db_session.add(source)
    await db_session.flush()

    stale_status = SourceIngestionStatus(
        source_id=source.id,
        last_ingested_at=datetime.now(timezone.utc) - timedelta(hours=2),
        last_event_timestamp=None,
        last_event_created_at=None,
        last_seen_at=None,
        events_per_min=0,
        parse_error_count=0,
    )
    db_session.add(stale_status)
    await db_session.commit()

    resp = await client.post("/api/v1/ingestion/run", json={"source_ids": [source.id]})
    assert resp.status_code == 202
    assert resp.json()["accepted"] is True

    status_result = await db_session.execute(
        select(SourceIngestionStatus).where(SourceIngestionStatus.source_id == source.id)
    )
    refreshed = status_result.scalar_one()
    assert refreshed.last_event_created_at is not None
    assert refreshed.last_event_timestamp is not None
    assert refreshed.last_seen_at == refreshed.last_event_created_at
    assert refreshed.events_per_min >= 1
