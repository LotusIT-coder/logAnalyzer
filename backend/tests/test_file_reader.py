"""Unit tests for file_reader helpers (syslog parsing, cursor logic)."""
from __future__ import annotations

import json
import os

import pytest
from sqlalchemy import select

from app.domain.models import Event, Source
import app.ingestion.file_reader as file_reader
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
    async def test_filebeat_source_normalizes_ecs_fields(self, db_session, tmp_path):
        log_path = tmp_path / "filebeat-json.log"
        log_path.write_text(
            json.dumps({
                "@timestamp": "2026-05-06T10:02:00+00:00",
                "event": {"code": "4625"},
                "host": {"name": "srv-auth-02"},
                "user": {"name": "admin"},
                "process": {"command_line": "powershell.exe -enc AAAA"},
                "source": {"ip": "10.0.0.8"},
                "log": {"level": "warning"},
            }) + "\n",
            encoding="utf-8",
        )

        source = Source(
            name="filebeat-auth",
            type="filebeat",
            config_json={"path": str(log_path)},
            enabled=True,
        )
        db_session.add(source)
        await db_session.flush()

        stats = await ingest_source(db_session, source)

        assert stats["events_created"] == 1
        result = await db_session.execute(select(Event).where(Event.source_id == source.id))
        event = result.scalar_one()
        assert event.host == "srv-auth-02"
        assert event.event_type == "4625"
        assert event.fields_json["username"] == "admin"
        assert event.fields_json["source_ip"] == "10.0.0.8"
        assert event.fields_json["process_command_line"] == "powershell.exe -enc AAAA"
        assert event.message

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

    async def test_journald_source_decodes_byte_array_message(self, db_session, tmp_path):
        """Test that _map_journald_entry decodes MESSAGE as byte array."""
        from app.ingestion.file_reader import _map_journald_entry

        text = "soc_analyst_started model=llama3"
        entry = {
            "MESSAGE": list(text.encode("utf-8")),
            "PRIORITY": "6",
            "_HOSTNAME": "srv-ai-01",
            "SYSLOG_IDENTIFIER": "bash",
            "__REALTIME_TIMESTAMP": "1746676860000000",
        }

        mapped = _map_journald_entry(entry)
        
        assert mapped["message"] == text
        assert "soc_analyst_started" in mapped["message"]

    async def test_file_source_regex_path_tracks_rotated_filenames(self, db_session, tmp_path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        day1 = log_dir / "lotus-client-2026-05-01.log"
        day2 = log_dir / "lotus-client-2026-05-02.log"
        day1.write_text("line-1\n", encoding="utf-8")

        source = Source(
            name="lotus-client",
            type="file",
            config_json={
                "path": str(log_dir / r"lotus-client-[0-9]{4}-[0-9]{2}-[0-9]{2}\.log"),
                "path_regex": True,
            },
            enabled=True,
        )
        db_session.add(source)
        await db_session.flush()

        first = await ingest_source(db_session, source)
        assert first["events_created"] == 1

        day1.write_text("line-1\nline-2\n", encoding="utf-8")
        second = await ingest_source(db_session, source)
        assert second["events_created"] == 1

        day2.write_text("line-a\n", encoding="utf-8")
        os.utime(day2, None)

        third = await ingest_source(db_session, source)
        assert third["events_created"] == 1

        result = await db_session.execute(select(Event).where(Event.source_id == source.id))
        events = list(result.scalars().all())
        assert len(events) == 3
        messages = sorted(e.message for e in events)
        assert messages == ["line-1", "line-2", "line-a"]

    async def test_file_source_fast_forwards_on_large_backlog(self, db_session, tmp_path, monkeypatch):
        log_path = tmp_path / "huge.log"
        content = "".join([f"old-{i}\n" for i in range(200)]) + "".join([f"recent-{i}\n" for i in range(12)])
        log_path.write_text(content, encoding="utf-8")

        # Lower thresholds for test so a small file still triggers fast-forward.
        monkeypatch.setattr(file_reader, "_MAX_BACKLOG_BYTES_BEFORE_FAST_FORWARD", 100)
        monkeypatch.setattr(file_reader, "_FAST_FORWARD_TAIL_BYTES", 120)

        source = Source(
            name="huge-file",
            type="file",
            config_json={"path": str(log_path)},
            enabled=True,
        )
        db_session.add(source)
        await db_session.flush()

        stats = await ingest_source(db_session, source)
        assert stats["fast_forwarded"] is True
        assert stats["start_offset"] > 0

        result = await db_session.execute(select(Event).where(Event.source_id == source.id))
        events = list(result.scalars().all())
        assert events
        assert any("recent-" in (e.message or "") for e in events)

    async def test_file_source_skips_unreadable_file(self, db_session, tmp_path, monkeypatch):
        log_path = tmp_path / "boot.log"
        log_path.write_text("cannot read me\n", encoding="utf-8")

        source = Source(
            name="boot",
            type="file",
            config_json={"path": str(log_path)},
            enabled=True,
        )
        db_session.add(source)
        await db_session.flush()

        real_open = open

        def fake_open(path, *args, **kwargs):
            if os.fspath(path) == os.fspath(log_path):
                raise PermissionError("Permission denied")
            return real_open(path, *args, **kwargs)

        monkeypatch.setattr("builtins.open", fake_open)

        stats = await ingest_source(db_session, source)

        assert stats["skipped"] is True
        assert "Permission denied" in stats["reason"] or "no read permission" in stats["reason"]
        result = await db_session.execute(select(Event).where(Event.source_id == source.id))
        assert list(result.scalars().all()) == []

    async def test_real_journald_source_uses_journalctl(self, db_session, monkeypatch):
        source = Source(
            name="journald-boot",
            type="journald",
            config_json={"boot_only": True},
            enabled=True,
        )
        db_session.add(source)
        await db_session.flush()

        class FakeProcess:
            returncode = 0

            async def communicate(self):
                payload = json.dumps({
                    "__CURSOR": "cursor-1",
                    "__REALTIME_TIMESTAMP": "1746525660000000",
                    "PRIORITY": "3",
                    "MESSAGE": "System boot complete",
                    "_HOSTNAME": "srv-01",
                    "SYSLOG_IDENTIFIER": "systemd",
                })
                return payload.encode("utf-8"), b""

        async def fake_create_subprocess_exec(*cmd, **kwargs):
            assert "journalctl" in cmd[0]
            assert "-b" in cmd
            return FakeProcess()

        monkeypatch.setattr(file_reader.asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

        stats = await ingest_source(db_session, source)

        assert stats["events_created"] == 1
        result = await db_session.execute(select(Event).where(Event.source_id == source.id))
        event = result.scalar_one()
        assert event.message == "System boot complete"
        assert event.service == "systemd"
        assert event.host == "srv-01"
        assert event.severity == "error"
