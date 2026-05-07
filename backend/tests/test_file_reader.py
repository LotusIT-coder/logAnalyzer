"""Unit tests for file_reader helpers (syslog parsing, cursor logic)."""
from __future__ import annotations

import json

import pytest
from sqlalchemy import select

from app.domain.models import Event, Source
from app.ingestion.file_reader import _parse_syslog_header, ingest_source


class TestSyslogHeaderParsing:
    def test_iso8601_format(self):
        line = "2026-05-03T10:15:30.123456+02:00 myhost myservice[1234]: Something happened"
        result = _parse_syslog_header(line)
        assert result is not None
        assert result["host"] == "myhost"
        assert result["service"] == "myservice"
        assert "Something happened" in result["message"]
        assert result["timestamp"] is not None

    def test_iso8601_utc_z(self):
        line = "2026-05-03T10:15:30Z webserver nginx[99]: GET /health 200"
        result = _parse_syslog_header(line)
        assert result is not None
        assert result["host"] == "webserver"
        assert result["service"] == "nginx"

    def test_rfc3164_format(self):
        line = "May  3 11:19:56 myhost sshd[5678]: Accepted publickey for root"
        result = _parse_syslog_header(line)
        assert result is not None
        assert result["host"] == "myhost"
        assert result["service"] == "sshd"
        assert "Accepted publickey" in result["message"]

    def test_rfc3164_single_digit_day(self):
        line = "May  3 11:19:56 srv kernel: OOM killer activated"
        result = _parse_syslog_header(line)
        assert result is not None
        assert result["host"] == "srv"

    def test_unrecognised_line_returns_none(self):
        result = _parse_syslog_header("this is not a syslog line at all")
        assert result is None

    def test_empty_line_returns_none(self):
        result = _parse_syslog_header("")
        assert result is None

    def test_service_without_pid(self):
        line = "2026-01-01T00:00:00Z host1 crond: job started"
        result = _parse_syslog_header(line)
        assert result is not None
        assert result["service"] == "crond"


@pytest.mark.asyncio
class TestSpecializedSourceIngestion:
    async def test_docker_source_ingests_json_log_file(self, db_session, tmp_path):
        log_path = tmp_path / "container-json.log"
        log_path.write_text(
            json.dumps({
                "log": "container booted\n",
                "stream": "stdout",
                "time": "2026-05-06T10:00:00+00:00",
            }) + "\n",
            encoding="utf-8",
        )

        source = Source(
            name="docker-nginx",
            type="docker",
            config_json={"path": str(log_path)},
            enabled=True,
        )
        db_session.add(source)
        await db_session.flush()

        stats = await ingest_source(db_session, source)

        assert stats["events_created"] == 1
        result = await db_session.execute(select(Event).where(Event.source_id == source.id))
        event = result.scalar_one()
        assert event.message == "container booted"
        assert event.fields_json["stream"] == "stdout"
        assert event.timestamp.isoformat().startswith("2026-05-06T10:00:00")

    async def test_journald_source_ingests_exported_json_file(self, db_session, tmp_path):
        log_path = tmp_path / "journald-export.jsonl"
        log_path.write_text(
            json.dumps({
                "MESSAGE": "Failed password for root",
                "PRIORITY": "3",
                "_HOSTNAME": "srv-auth-01",
                "SYSLOG_IDENTIFIER": "sshd",
                "__REALTIME_TIMESTAMP": "2026-05-06T10:01:00+00:00",
            }) + "\n",
            encoding="utf-8",
        )

        source = Source(
            name="journald-auth",
            type="journald",
            config_json={"path": str(log_path)},
            enabled=True,
        )
        db_session.add(source)
        await db_session.flush()

        stats = await ingest_source(db_session, source)

        assert stats["events_created"] == 1
        result = await db_session.execute(select(Event).where(Event.source_id == source.id))
        event = result.scalar_one()
        assert event.message == "Failed password for root"
        assert event.service == "sshd"
        assert event.host == "srv-auth-01"
        assert event.severity == "error"
        assert event.timestamp.isoformat().startswith("2026-05-06T10:01:00")
