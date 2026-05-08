"""Remove network ingest tables and restore source type constraint.

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-08
"""
from __future__ import annotations

from alembic import op


revision: str = "0006"
down_revision: str | None = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Drop network tables (CASCADE handles FK from network_ingest_batch → source)
    op.drop_table("network_ingest_batch")
    op.drop_table("network_flow")

    # Restore source type check constraint to log-only types
    op.drop_constraint("ck_source_type", "source", type_="check")
    op.create_check_constraint(
        "ck_source_type",
        "source",
        "type IN ('file','syslog','journald','docker')",
    )


def downgrade() -> None:
    # Re-add network source types to constraint
    op.drop_constraint("ck_source_type", "source", type_="check")
    op.create_check_constraint(
        "ck_source_type",
        "source",
        "type IN ('file','syslog','journald','docker','netflow','sflow','socket_observer','packet_capture')",
    )
    # Note: network_flow and network_ingest_batch tables are not recreated here;
    # apply migration 0005 manually if a full rollback is needed.
