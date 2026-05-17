"""Add 15-minute event timeseries rollup table.

Revision ID: 0024_event_timeseries_rollup
Revises: 0023_src_ingest_status_cache
Create Date: 2026-05-17
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0024_event_timeseries_rollup"
down_revision = "0023_src_ingest_status_cache"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "event_timeseries_rollup_15m",
        sa.Column("source_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("source.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("bucket_start", sa.DateTime(timezone=True), primary_key=True),
        sa.Column("total_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("error_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index(
        "idx_event_timeseries_rollup_15m_bucket_start",
        "event_timeseries_rollup_15m",
        [sa.text("bucket_start DESC")],
    )


def downgrade() -> None:
    op.drop_index("idx_event_timeseries_rollup_15m_bucket_start", table_name="event_timeseries_rollup_15m")
    op.drop_table("event_timeseries_rollup_15m")
