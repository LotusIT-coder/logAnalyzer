"""Add composite indexes on event table for common filter+sort patterns.

Revision ID: 0009
Revises: 0008
Create Date: 2026-05-08
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # (source_id, timestamp DESC) – covers the common "filter by source, order
    # by time" query on the events list endpoint.
    op.create_index(
        "idx_event_source_id_timestamp",
        "event",
        ["source_id", sa.text("timestamp DESC")],
    )

    # (severity, timestamp DESC) – covers severity-filter queries ordered by time.
    op.create_index(
        "idx_event_severity_timestamp",
        "event",
        ["severity", sa.text("timestamp DESC")],
    )

    # created_at DESC – used by the SSE stream and the stream helper queries.
    op.create_index(
        "idx_event_created_at",
        "event",
        [sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("idx_event_created_at", table_name="event")
    op.drop_index("idx_event_severity_timestamp", table_name="event")
    op.drop_index("idx_event_source_id_timestamp", table_name="event")
