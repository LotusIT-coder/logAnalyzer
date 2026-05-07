"""Add role column to api_token.

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-06
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "0002"
down_revision: str | None = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "api_token",
        sa.Column("role", sa.Text(), nullable=False, server_default="viewer"),
    )
    op.create_check_constraint(
        "ck_api_token_role",
        "api_token",
        "role IN ('viewer','analyst','operator','admin')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_api_token_role", "api_token", type_="check")
    op.drop_column("api_token", "role")