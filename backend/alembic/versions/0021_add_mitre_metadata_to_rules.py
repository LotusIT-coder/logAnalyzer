"""Add MITRE metadata fields to rules.

Revision ID: 0021_add_mitre_metadata_to_rules
Revises: 0020_add_incident_confidence_fields
Create Date: 2026-05-15 12:10:00
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0021_add_mitre_metadata_to_rules"
down_revision = "0020_incident_conf_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("rule", sa.Column("mitre_techniques_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column("rule", sa.Column("mitre_tactic", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("rule", "mitre_tactic")
    op.drop_column("rule", "mitre_techniques_json")
