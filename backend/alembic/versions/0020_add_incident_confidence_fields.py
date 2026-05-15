"""Add incident confidence score and rationale fields.

Revision ID: 0020_add_incident_confidence_fields
Revises: 0019_add_suspicious_powershell_chain_rule
Create Date: 2026-05-15 10:30:00
"""

from alembic import op
import sqlalchemy as sa


revision = "0020_incident_conf_fields"
down_revision = "0019_susp_pwsh_chain_rule"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("incident", sa.Column("confidence_score", sa.Numeric(5, 2), nullable=True))
    op.add_column("incident", sa.Column("confidence_rationale", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("incident", "confidence_rationale")
    op.drop_column("incident", "confidence_score")
