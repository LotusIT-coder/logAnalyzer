"""Extend source type constraint with beats and elastic agent types.

Revision ID: 0014
Revises: 0013
Create Date: 2026-05-15
"""
from __future__ import annotations

from alembic import op


revision: str = "0014"
down_revision: str | None = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_source_type", "source", type_="check")
    op.create_check_constraint(
        "ck_source_type",
        "source",
        "type IN ('file','syslog','journald','docker','filebeat','winlogbeat','elastic_agent')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_source_type", "source", type_="check")
    op.create_check_constraint(
        "ck_source_type",
        "source",
        "type IN ('file','syslog','journald','docker')",
    )
