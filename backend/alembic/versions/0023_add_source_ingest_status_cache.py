"""Add source ingestion status cache table.

Revision ID: 0023_src_ingest_status_cache
Revises: 0022_add_mitre_fields_incident
Create Date: 2026-05-15
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0023_src_ingest_status_cache"
down_revision = "0022_add_mitre_fields_incident"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "source_ingestion_status",
        sa.Column("source_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("source.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("last_ingested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_event_timestamp", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_event_created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("events_per_min", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("parse_error_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )


def downgrade() -> None:
    op.drop_table("source_ingestion_status")
