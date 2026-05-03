"""Initial schema.

Revision ID: 0001
Revises: 
Create Date: 2026-05-03
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")

    op.create_table(
        "source",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("type", sa.Text, nullable=False),
        sa.Column("config_json", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint("type IN ('file','syslog','journald','docker')", name="ck_source_type"),
    )

    op.create_table(
        "raw_log",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("source_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("source.id", ondelete="CASCADE"), nullable=False),
        sa.Column("ingested_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("raw_line", sa.Text, nullable=False),
        sa.Column("raw_hash", sa.Text),
        sa.Column("cursor", sa.Text),
    )
    op.create_index("idx_raw_log_source_id", "raw_log", ["source_id"])
    op.create_index("idx_raw_log_ingested_at", "raw_log", [sa.text("ingested_at DESC")])

    op.create_table(
        "parser_profile",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("format", sa.Text, nullable=False),
        sa.Column("pattern", sa.Text),
        sa.Column("mapping_json", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("priority", sa.Integer, nullable=False, server_default="100"),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint("format IN ('json','regex','grok','kv')", name="ck_parser_profile_format"),
    )
    op.create_index("idx_parser_profile_enabled_priority", "parser_profile", ["enabled", "priority"])

    op.create_table(
        "event",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("source_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("source.id", ondelete="CASCADE"), nullable=False),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("severity", sa.Text, nullable=False),
        sa.Column("service", sa.Text),
        sa.Column("host", sa.Text),
        sa.Column("environment", sa.Text),
        sa.Column("message", sa.Text, nullable=False),
        sa.Column("event_type", sa.Text),
        sa.Column("fields_json", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("fingerprint", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("idx_event_timestamp", "event", [sa.text("timestamp DESC")])
    op.create_index("idx_event_severity", "event", ["severity"])
    op.create_index("idx_event_service", "event", ["service"])
    op.create_index("idx_event_host", "event", ["host"])
    op.create_index("idx_event_fingerprint", "event", ["fingerprint"])
    op.create_index("idx_event_fields_gin", "event", ["fields_json"], postgresql_using="gin")

    op.create_table(
        "rule",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("condition_json", postgresql.JSONB, nullable=False),
        sa.Column("threshold", sa.Integer, nullable=False),
        sa.Column("window_seconds", sa.Integer, nullable=False),
        sa.Column("severity", sa.Text, nullable=False),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint("threshold > 0", name="ck_rule_threshold"),
        sa.CheckConstraint("window_seconds > 0", name="ck_rule_window"),
    )
    op.create_index("idx_rule_enabled", "rule", ["enabled"])

    op.create_table(
        "incident",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("severity", sa.Text, nullable=False),
        sa.Column("first_seen", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen", sa.DateTime(timezone=True), nullable=False),
        sa.Column("event_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("rule_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("rule.id", ondelete="SET NULL"), nullable=True),
        sa.Column("summary", sa.Text),
        sa.Column("assignee", sa.Text),
        sa.Column("tags_json", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint(
            "status IN ('open','investigating','resolved','false_positive')",
            name="ck_incident_status",
        ),
    )
    op.create_index("idx_incident_status", "incident", ["status"])
    op.create_index("idx_incident_severity", "incident", ["severity"])
    op.create_index("idx_incident_last_seen", "incident", [sa.text("last_seen DESC")])

    op.create_table(
        "incident_event",
        sa.Column("incident_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("incident.id", ondelete="CASCADE"), nullable=False),
        sa.Column("event_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("event.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("incident_id", "event_id"),
    )
    op.create_index("idx_incident_event_event_id", "incident_event", ["event_id"])

    op.create_table(
        "model_profile",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("name", sa.Text, nullable=False, unique=True),
        sa.Column("purpose", sa.Text, nullable=False),
        sa.Column("ollama_model", sa.Text, nullable=False),
        sa.Column("temperature", sa.Numeric(3, 2), nullable=False, server_default="0.20"),
        sa.Column("max_tokens", sa.Integer, nullable=False, server_default="1024"),
        sa.Column("system_prompt_template", sa.Text, nullable=False),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint("purpose IN ('triage','deep','security')", name="ck_model_profile_purpose"),
    )
    op.create_index("idx_model_profile_purpose_enabled", "model_profile", ["purpose", "enabled"])

    op.create_table(
        "ai_analysis",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("target_type", sa.Text, nullable=False),
        sa.Column("target_ref", sa.Text, nullable=False),
        sa.Column("model_name", sa.Text, nullable=False),
        sa.Column("prompt_version", sa.Text, nullable=False),
        sa.Column("input_digest", sa.Text),
        sa.Column("result_text", sa.Text),
        sa.Column("confidence", sa.Numeric(5, 2)),
        sa.Column("latency_ms", sa.Integer),
        sa.Column("token_usage_json", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint(
            "target_type IN ('window','incident','event_set')",
            name="ck_ai_analysis_target_type",
        ),
    )
    op.create_index("idx_ai_analysis_target", "ai_analysis", ["target_type", "target_ref"])
    op.create_index("idx_ai_analysis_created_at", "ai_analysis", [sa.text("created_at DESC")])

    op.create_table(
        "api_token",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("scope_json", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("token_hash", sa.Text, nullable=False, unique=True),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("last_used_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
    )
    op.create_index("idx_api_token_revoked", "api_token", ["revoked_at"])
    op.create_index("idx_api_token_expires_at", "api_token", ["expires_at"])

    op.create_table(
        "audit_log",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("actor", sa.Text, nullable=False),
        sa.Column("action", sa.Text, nullable=False),
        sa.Column("resource", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("meta_json", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("idx_audit_log_created_at", "audit_log", [sa.text("created_at DESC")])
    op.create_index("idx_audit_log_actor", "audit_log", ["actor"])

    # updated_at trigger function
    op.execute("""
        CREATE OR REPLACE FUNCTION set_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    """)
    for tbl in ("source", "parser_profile", "rule", "incident", "model_profile"):
        op.execute(f"""
            CREATE TRIGGER {tbl}_set_updated_at
            BEFORE UPDATE ON {tbl}
            FOR EACH ROW EXECUTE FUNCTION set_updated_at()
        """)


def downgrade() -> None:
    for tbl in ("source", "parser_profile", "rule", "incident", "model_profile"):
        op.execute(f"DROP TRIGGER IF EXISTS {tbl}_set_updated_at ON {tbl}")
    op.execute("DROP FUNCTION IF EXISTS set_updated_at()")

    for tbl in (
        "audit_log", "api_token", "ai_analysis", "model_profile",
        "incident_event", "incident", "rule", "event",
        "parser_profile", "raw_log", "source",
    ):
        op.drop_table(tbl)
