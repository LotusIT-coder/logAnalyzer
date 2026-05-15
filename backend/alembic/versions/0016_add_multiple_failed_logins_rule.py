"""Add sequence-based multiple failed logins correlation rule.

Revision ID: 0016
Revises: 0015
Create Date: 2026-05-15
"""
from __future__ import annotations

from alembic import op


revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO rule (
            id,
            name,
            description,
            condition_json,
            sequence_json,
            group_by_entity,
            threshold,
            window_seconds,
            severity,
            enabled
        )
        SELECT
            gen_random_uuid(),
            'Multiple Failed Logins',
            'Correlates repeated failed login attempts for the same user and source IP within a short time window.',
            '{}'::jsonb,
            '[
              {"field": "event_action", "value": "failed_password"},
              {"field": "event_action", "value": "failed_password"},
              {"field": "event_action", "value": "failed_password"}
            ]'::jsonb,
            'username,source_ip',
            1,
            300,
            'warning',
            true
        WHERE NOT EXISTS (
            SELECT 1 FROM rule WHERE name = 'Multiple Failed Logins'
        )
        """
    )


def downgrade() -> None:
    op.execute("DELETE FROM rule WHERE name = 'Multiple Failed Logins'")
