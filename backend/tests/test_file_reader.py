"""Unit tests for file_reader helpers (syslog parsing, cursor logic)."""
from __future__ import annotations

import pytest
from app.ingestion.file_reader import _parse_syslog_header


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
