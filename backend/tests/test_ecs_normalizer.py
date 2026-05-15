from __future__ import annotations

from app.ingestion.ecs_normalizer import normalize_ecs_payload


def test_normalize_ecs_nested_fields_to_internal_keys():
    parsed = {
        "host": {"name": "srv-auth-01"},
        "event": {"code": "4625"},
        "user": {"name": "administrator"},
        "process": {"command_line": "powershell.exe -enc AAAA"},
        "source": {"ip": "10.10.10.5"},
    }

    normalized = normalize_ecs_payload(parsed, raw_line="raw line fallback")

    assert normalized["host"] == "srv-auth-01"
    assert normalized["event_type"] == "4625"
    assert normalized["username"] == "administrator"
    assert normalized["process_command_line"] == "powershell.exe -enc AAAA"
    assert normalized["source_ip"] == "10.10.10.5"
    assert normalized["message"] == "raw line fallback"


def test_normalize_ecs_dotted_keys_to_internal_keys():
    parsed = {
        "host.name": "srv-db-02",
        "event.code": 4769,
        "user.name": "svc_sql",
        "process.command_line": "cmd /c whoami",
        "source.ip": "192.168.2.50",
        "message": "auth event",
    }

    normalized = normalize_ecs_payload(parsed, raw_line="unused fallback")

    assert normalized["host"] == "srv-db-02"
    assert normalized["event_type"] == "4769"
    assert normalized["username"] == "svc_sql"
    assert normalized["process_command_line"] == "cmd /c whoami"
    assert normalized["source_ip"] == "192.168.2.50"
    assert normalized["message"] == "auth event"


def test_normalize_ecs_preserves_existing_canonical_values():
    parsed = {
        "host": "canonical-host",
        "event_type": "custom-event",
        "username": "existing-user",
        "process_command_line": "existing cmd",
        "source_ip": "127.0.0.1",
        "message": "existing message",
        "host.name": "nested-host",
        "event.code": "9999",
        "user.name": "nested-user",
        "process.command_line": "nested cmd",
        "source.ip": "10.0.0.1",
    }

    normalized = normalize_ecs_payload(parsed, raw_line="fallback message")

    assert normalized["host"] == "canonical-host"
    assert normalized["event_type"] == "custom-event"
    assert normalized["username"] == "existing-user"
    assert normalized["process_command_line"] == "existing cmd"
    assert normalized["source_ip"] == "127.0.0.1"
    assert normalized["message"] == "existing message"
