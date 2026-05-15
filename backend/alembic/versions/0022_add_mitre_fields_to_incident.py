"""Add MITRE enrichment fields to incidents.

Revision ID: 0022_add_mitre_fields_to_incident
Revises: 0021_add_mitre_metadata_to_rules
Create Date: 2026-05-15 12:35:00
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0022_add_mitre_fields_incident"
down_revision = "0021_add_mitre_metadata_to_rules"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("incident", sa.Column("mitre_techniques_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column("incident", sa.Column("mitre_tactic", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("incident", "mitre_tactic")
    op.drop_column("incident", "mitre_techniques_json")
