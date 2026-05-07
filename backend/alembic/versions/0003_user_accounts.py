"""Add user accounts and token-to-user linkage.

Revision ID: 0003
Revises: 0002
Create Date: 2026-05-06
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0003"
down_revision: str | None = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_account",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("email", sa.Text(), nullable=False, unique=True),
        sa.Column("role", sa.Text(), nullable=False, server_default="viewer"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint("role IN ('viewer','analyst','operator','admin')", name="ck_user_account_role"),
    )
    op.add_column("api_token", sa.Column("user_id", postgresql.UUID(as_uuid=False), nullable=True))
    op.create_foreign_key(
        "fk_api_token_user_id",
        "api_token",
        "user_account",
        ["user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.execute(
        """
        CREATE TRIGGER user_account_set_updated_at
        BEFORE UPDATE ON user_account
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS user_account_set_updated_at ON user_account")
    op.drop_constraint("fk_api_token_user_id", "api_token", type_="foreignkey")
    op.drop_column("api_token", "user_id")
    op.drop_table("user_account")