-- Initial PostgreSQL schema for Log Analyzer MVP
-- Focus: source ingestion, normalized events, incidents, AI analysis, and API security.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE source (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('file', 'syslog', 'journald', 'docker', 'netflow', 'sflow', 'socket_observer', 'packet_capture')),
    config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE raw_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw_line TEXT NOT NULL,
    raw_hash TEXT,
    cursor TEXT
);

CREATE INDEX idx_raw_log_source_id ON raw_log (source_id);
CREATE INDEX idx_raw_log_ingested_at ON raw_log (ingested_at DESC);

CREATE TABLE parser_profile (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('json', 'regex', 'grok', 'kv')),
    pattern TEXT,
    mapping_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    priority INTEGER NOT NULL DEFAULT 100,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_parser_profile_enabled_priority ON parser_profile (enabled, priority);

CREATE TABLE event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE,
    timestamp TIMESTAMPTZ NOT NULL,
    severity TEXT NOT NULL,
    service TEXT,
    host TEXT,
    environment TEXT,
    message TEXT NOT NULL,
    event_type TEXT,
    fields_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    fingerprint TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_event_timestamp ON event (timestamp DESC);
CREATE INDEX idx_event_severity ON event (severity);
CREATE INDEX idx_event_service ON event (service);
CREATE INDEX idx_event_host ON event (host);
CREATE INDEX idx_event_fingerprint ON event (fingerprint);
CREATE INDEX idx_event_fields_gin ON event USING GIN (fields_json);

CREATE TABLE network_flow (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE,
    collector_node_id TEXT,
    telemetry_type TEXT NOT NULL CHECK (telemetry_type IN ('netflow', 'ipfix', 'sflow', 'socket_observer')),
    observed_at_start TIMESTAMPTZ NOT NULL,
    observed_at_end TIMESTAMPTZ NOT NULL,
    host_id TEXT,
    exporter_addr INET,
    observation_domain_id BIGINT,
    src_ip INET NOT NULL,
    dst_ip INET NOT NULL,
    src_port INTEGER,
    dst_port INTEGER,
    protocol TEXT NOT NULL,
    bytes BIGINT NOT NULL DEFAULT 0,
    packets BIGINT NOT NULL DEFAULT 0,
    connections INTEGER NOT NULL DEFAULT 1,
    direction TEXT,
    action TEXT,
    app_hint TEXT,
    process_name TEXT,
    sample_factor NUMERIC(12,4) NOT NULL DEFAULT 1.0,
    confidence NUMERIC(5,4) NOT NULL DEFAULT 1.0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_network_flow_observed_at_end ON network_flow (observed_at_end DESC);
CREATE INDEX idx_network_flow_source_id_time ON network_flow (source_id, observed_at_end DESC);
CREATE INDEX idx_network_flow_src_ip_time ON network_flow (src_ip, observed_at_end DESC);
CREATE INDEX idx_network_flow_dst_ip_time ON network_flow (dst_ip, observed_at_end DESC);
CREATE INDEX idx_network_flow_protocol_port ON network_flow (protocol, dst_port);
CREATE INDEX idx_network_flow_host_process ON network_flow (host_id, process_name);

CREATE TABLE network_ingest_batch (
    batch_id UUID PRIMARY KEY,
    collector_node_id TEXT NOT NULL,
    source_id UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE,
    telemetry_type TEXT NOT NULL CHECK (telemetry_type IN ('netflow', 'ipfix', 'sflow', 'socket_observer')),
    schema_version INTEGER NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
    item_count INTEGER NOT NULL DEFAULT 0,
    error_text TEXT
);

CREATE INDEX idx_network_ingest_batch_source_received ON network_ingest_batch (source_id, received_at DESC);
CREATE INDEX idx_network_ingest_batch_status_received ON network_ingest_batch (status, received_at DESC);

CREATE TABLE rule (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    condition_json JSONB NOT NULL,
    threshold INTEGER NOT NULL CHECK (threshold > 0),
    window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
    severity TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rule_enabled ON rule (enabled);

CREATE TABLE incident (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'investigating', 'resolved', 'false_positive', 'archived')),
    severity TEXT NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL,
    event_count INTEGER NOT NULL DEFAULT 0,
    rule_id UUID REFERENCES rule(id) ON DELETE SET NULL,
    summary TEXT,
    assignee TEXT,
    tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_incident_status ON incident (status);
CREATE INDEX idx_incident_severity ON incident (severity);
CREATE INDEX idx_incident_last_seen ON incident (last_seen DESC);

CREATE TABLE incident_event (
    incident_id UUID NOT NULL REFERENCES incident(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES event(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (incident_id, event_id)
);

CREATE INDEX idx_incident_event_event_id ON incident_event (event_id);

CREATE TABLE model_profile (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    purpose TEXT NOT NULL CHECK (purpose IN ('triage', 'deep', 'security')),
    ollama_model TEXT NOT NULL,
    temperature NUMERIC(3,2) NOT NULL DEFAULT 0.20,
    max_tokens INTEGER NOT NULL DEFAULT 1024,
    system_prompt_template TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_model_profile_purpose_enabled ON model_profile (purpose, enabled);

CREATE TABLE ai_analysis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_type TEXT NOT NULL CHECK (target_type IN ('window', 'incident', 'event_set')),
    target_ref TEXT NOT NULL,
    model_name TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    input_digest TEXT,
    result_text TEXT,
    confidence NUMERIC(5,2),
    latency_ms INTEGER,
    token_usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_analysis_target ON ai_analysis (target_type, target_ref);
CREATE INDEX idx_ai_analysis_created_at ON ai_analysis (created_at DESC);

CREATE TABLE user_account (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'analyst', 'operator', 'admin')),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE api_token (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    user_id UUID REFERENCES user_account(id) ON DELETE SET NULL,
    role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'analyst', 'operator', 'admin')),
    scope_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_api_token_revoked ON api_token (revoked_at);
CREATE INDEX idx_api_token_expires_at ON api_token (expires_at);

CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    status TEXT NOT NULL,
    meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_created_at ON audit_log (created_at DESC);
CREATE INDEX idx_audit_log_actor ON audit_log (actor);

-- Simple helper function and trigger to auto-update updated_at columns.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_set_updated_at
BEFORE UPDATE ON source
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER parser_profile_set_updated_at
BEFORE UPDATE ON parser_profile
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER rule_set_updated_at
BEFORE UPDATE ON rule
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER incident_set_updated_at
BEFORE UPDATE ON incident
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER model_profile_set_updated_at
BEFORE UPDATE ON model_profile
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER user_account_set_updated_at
BEFORE UPDATE ON user_account
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
