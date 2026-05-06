"""Unit tests for the parser pipeline (no DB, no network)."""
from __future__ import annotations

import pytest
from app.parser.pipeline import parse_line, _expand_grok, _parse_kv


# ---------------------------------------------------------------------------
# JSON parser
# ---------------------------------------------------------------------------

class TestJsonParser:
    def test_basic_json_line(self):
        line = '{"severity": "error", "message": "disk full", "service": "storage"}'
        result = parse_line(line, fmt="json", pattern=None, mapping=None)
        assert result is not None
        assert result["severity"] == "error"
        assert result["message"] == "disk full"
        assert result["service"] == "storage"

    def test_severity_normalisation_warn(self):
        line = '{"severity": "warn", "message": "low memory"}'
        result = parse_line(line, fmt="json", pattern=None, mapping=None)
        assert result["severity"] == "warning"

    def test_severity_normalisation_fatal(self):
        line = '{"severity": "FATAL", "message": "crash"}'
        result = parse_line(line, fmt="json", pattern=None, mapping=None)
        assert result["severity"] == "critical"

    def test_severity_normalisation_err(self):
        line = '{"severity": "err", "message": "oops"}'
        result = parse_line(line, fmt="json", pattern=None, mapping=None)
        assert result["severity"] == "error"

    def test_fallback_msg_key(self):
        """If 'message' absent, 'msg' should be used as fallback."""
        line = '{"severity": "info", "msg": "hello"}'
        result = parse_line(line, fmt="json", pattern=None, mapping=None)
        assert result["message"] == "hello"

    def test_fallback_log_key(self):
        line = '{"level": "info", "log": "started"}'
        result = parse_line(line, fmt="json", pattern=None, mapping={"level": "severity"})
        assert result["message"] == "started"

    def test_field_mapping(self):
        line = '{"lvl": "debug", "text": "trace point"}'
        result = parse_line(line, fmt="json", pattern=None, mapping={"lvl": "severity", "text": "message"})
        assert result["severity"] == "debug"
        assert result["message"] == "trace point"

    def test_non_json_returns_none(self):
        result = parse_line("not json at all", fmt="json", pattern=None, mapping=None)
        assert result is None

    def test_empty_json_object(self):
        # Valid JSON but no useful fields → message empty string
        result = parse_line("{}", fmt="json", pattern=None, mapping=None)
        assert result is not None
        assert result["message"] == ""

    def test_nested_json_preserved_in_extra(self):
        line = '{"message": "ok", "meta": {"host": "srv1"}}'
        result = parse_line(line, fmt="json", pattern=None, mapping=None)
        assert result["message"] == "ok"
        assert result["meta"] == {"host": "srv1"}


# ---------------------------------------------------------------------------
# Regex parser
# ---------------------------------------------------------------------------

class TestRegexParser:
    NGINX_PATTERN = (
        r"(?P<host>\S+) - - \[(?P<timestamp>[^\]]+)\] "
        r"\"(?P<method>\S+) (?P<path>\S+) \S+\" (?P<status>\d+)"
    )

    def test_nginx_access_log(self):
        line = '127.0.0.1 - - [03/May/2026:12:00:00 +0200] "GET /api/v1/health HTTP/1.1" 200'
        result = parse_line(line, fmt="regex", pattern=self.NGINX_PATTERN, mapping={"status": "severity"})
        assert result is not None
        assert result["host"] == "127.0.0.1"
        assert result["path"] == "/api/v1/health"

    def test_no_match_returns_none(self):
        result = parse_line("totally unrelated", fmt="regex", pattern=self.NGINX_PATTERN, mapping=None)
        assert result is None

    def test_invalid_regex_returns_none(self):
        result = parse_line("anything", fmt="regex", pattern="[invalid(", mapping=None)
        assert result is None

    def test_named_groups_become_keys(self):
        pattern = r"(?P<severity>\w+): (?P<message>.+)"
        result = parse_line("ERROR: something broke", fmt="regex", pattern=pattern, mapping=None)
        assert result["severity"] == "error"
        assert result["message"] == "something broke"

    def test_severity_from_capture_group_normalised(self):
        pattern = r"(?P<severity>\w+): (?P<message>.+)"
        result = parse_line("WARN: almost full", fmt="regex", pattern=pattern, mapping=None)
        assert result["severity"] == "warning"


# ---------------------------------------------------------------------------
# Grok parser
# ---------------------------------------------------------------------------

class TestGrokParser:
    def test_grok_expand_basic(self):
        expanded = _expand_grok("%{LOGLEVEL:severity} %{GREEDYDATA:message}")
        assert "(?P<severity>" in expanded
        assert "(?P<message>" in expanded

    def test_grok_expand_without_name(self):
        expanded = _expand_grok("%{IP} accessed")
        assert "(?:" in expanded
        assert "(?P<" not in expanded

    def test_grok_parse_line(self):
        pattern = r"%{LOGLEVEL:severity}: %{GREEDYDATA:message}"
        result = parse_line("ERROR: disk full", fmt="grok", pattern=pattern, mapping=None)
        assert result is not None
        assert result["severity"] == "error"
        assert "disk full" in result["message"]

    def test_grok_no_match_returns_none(self):
        result = parse_line("  ", fmt="grok", pattern=r"%{LOGLEVEL:severity}", mapping=None)
        assert result is None


# ---------------------------------------------------------------------------
# Key-Value parser
# ---------------------------------------------------------------------------

class TestKVParser:
    def test_simple_kv(self):
        result = parse_line("level=error msg=crashed service=api", fmt="kv", pattern=None, mapping={"level": "severity", "msg": "message"})
        assert result is not None
        assert result["severity"] == "error"
        assert result["message"] == "crashed"
        assert result["service"] == "api"

    def test_quoted_values(self):
        result = parse_line('event=start msg="server started" host=web1', fmt="kv", pattern=None, mapping={"msg": "message"})
        assert result["message"] == "server started"
        assert result["host"] == "web1"

    def test_no_kv_pairs_returns_none(self):
        result = parse_line("no key value pairs here", fmt="kv", pattern=None, mapping=None)
        assert result is None

    def test_kv_severity_normalised(self):
        result = parse_line("severity=crit message=oops", fmt="kv", pattern=None, mapping=None)
        assert result["severity"] == "critical"


# ---------------------------------------------------------------------------
# Unknown format
# ---------------------------------------------------------------------------

def test_unknown_format_returns_none():
    result = parse_line("anything", fmt="unknown_fmt", pattern=None, mapping=None)
    assert result is None


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

def test_empty_line_json():
    assert parse_line("", fmt="json", pattern=None, mapping=None) is None

def test_whitespace_only_line_json():
    assert parse_line("   ", fmt="json", pattern=None, mapping=None) is None
