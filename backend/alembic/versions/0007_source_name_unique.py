"""Add unique constraint to source.name.

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-08
"""
from __future__ import annotations

from alembic import op


revision: str = "0007"
down_revision: str | None = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint("uq_source_name", "source", ["name"])


def downgrade() -> None:
    op.drop_constraint("uq_source_name", "source", type_="unique")
