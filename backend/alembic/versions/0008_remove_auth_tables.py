"""Remove auth-related tables.

Revision ID: 0008
Revises: 0007
Create Date: 2026-05-08
"""
from __future__ import annotations

from alembic import op


revision: str = "0008"
down_revision: str | None = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("audit_log")
    op.drop_table("api_token")
    op.drop_table("user_account")


def downgrade() -> None:
    raise NotImplementedError("Downgrade for 0008_remove_auth_tables is not supported.")
