"""Add sequence-capable fields to rules.

Revision ID: 0015
Revises: 0014
Create Date: 2026-05-15
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0015"
down_revision: str | None = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("rule", sa.Column("sequence_json", postgresql.JSONB, nullable=True))
    op.add_column("rule", sa.Column("group_by_entity", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("rule", "group_by_entity")
    op.drop_column("rule", "sequence_json")
