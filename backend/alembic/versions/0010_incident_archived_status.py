"""Allow archived incident status.

Revision ID: 0010
Revises: 0009
Create Date: 2026-05-10
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "0010"
down_revision: str | None = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_incident_status", "incident", type_="check")
    op.create_check_constraint(
        "ck_incident_status",
        "incident",
        "status IN ('open','investigating','resolved','false_positive','archived')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_incident_status", "incident", type_="check")
    op.create_check_constraint(
        "ck_incident_status",
        "incident",
        "status IN ('open','investigating','resolved','false_positive')",
    )
