"""Tests for incident notification helpers."""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.domain.models import Incident
from app.services.notifications import (
    _send_incident_notification,
    consume_incidents_marked_for_notification,
    mark_incident_for_notification,
)


class TestNotificationBookkeeping:
    def test_mark_and_consume_deduplicates_incident_ids(self):
        session = MagicMock()
        session.info = {}

        mark_incident_for_notification(session, "inc-1")
        mark_incident_for_notification(session, "inc-1")
        mark_incident_for_notification(session, "inc-2")

        pending = consume_incidents_marked_for_notification(session)

        assert pending == ["inc-1", "inc-2"]
        assert consume_incidents_marked_for_notification(session) == []


@pytest.mark.asyncio
class TestNotificationDispatch:
    async def test_send_incident_notification_posts_webhook_payload(self, engine, db_session: AsyncSession):
        incident = Incident(
            title="Rule fired: SSH burst",
            status="open",
            severity="warning",
            first_seen=datetime.now(timezone.utc),
            last_seen=datetime.now(timezone.utc),
            event_count=5,
            summary="Failed password spike on sshd",
            tags_json=["auth"],
        )
        db_session.add(incident)
        await db_session.commit()

        factory = async_sessionmaker(bind=engine, expire_on_commit=False, class_=AsyncSession)
        response = MagicMock()
        response.raise_for_status = MagicMock()
        client = AsyncMock()
        client.post = AsyncMock(return_value=response)
        client_cm = AsyncMock()
        client_cm.__aenter__.return_value = client
        client_cm.__aexit__.return_value = False
        settings = MagicMock(notification_webhook_url="http://notify.test/hook")

        with (
            patch("app.services.notifications.get_session_factory", return_value=factory),
            patch("app.services.notifications.get_settings", return_value=settings),
            patch("app.services.notifications.httpx.AsyncClient", return_value=client_cm),
        ):
            await _send_incident_notification(incident.id)

        client.post.assert_called_once()
        assert client.post.call_args.kwargs["json"]["incident_id"] == incident.id
        assert client.post.call_args.kwargs["json"]["title"] == "Rule fired: SSH burst"