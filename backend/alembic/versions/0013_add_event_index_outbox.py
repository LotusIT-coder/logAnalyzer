"""Add event index outbox queue table.

Revision ID: 0013
Revises: 0012
Create Date: 2026-05-15
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0013"
down_revision: str | None = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "event_index_outbox",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "event_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("event.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("payload_json", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("next_retry_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("processed_at", sa.DateTime(timezone=True)),
        sa.Column("last_error", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("idx_event_index_outbox_event_id", "event_index_outbox", ["event_id"])
    op.create_index(
        "idx_event_index_outbox_pending",
        "event_index_outbox",
        ["processed_at", sa.text("next_retry_at ASC"), sa.text("created_at ASC")],
    )

    op.execute(
        """
        CREATE TRIGGER event_index_outbox_set_updated_at
        BEFORE UPDATE ON event_index_outbox
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS event_index_outbox_set_updated_at ON event_index_outbox")
    op.drop_table("event_index_outbox")
