"""Add privilege escalation sequence correlation rule.

Revision ID: 0017
Revises: 0016
Create Date: 2026-05-15
"""
from __future__ import annotations

from alembic import op


revision = "0017_priv_esc_seq_rule"
down_revision = "0016"
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
            'Privilege Escalation Sequence',
            'Correlates authentication success followed by privilege assignment or sudo-style command execution on the same host and user.',
            '{}'::jsonb,
            '[
              {"field": "event_action", "value_in": ["login_success", "auth_success"]},
              {"field": "event_action", "value_in": ["privilege_change", "sudo_start", "admin_group_add"]},
              {"field": "event_action", "value_in": ["sensitive_command", "sudo_command", "credential_dump_attempt"]}
            ]'::jsonb,
            'username,host',
            1,
            600,
            'high',
            true
        WHERE NOT EXISTS (
            SELECT 1 FROM rule WHERE name = 'Privilege Escalation Sequence'
        )
        """
    )


def downgrade() -> None:
    op.execute("DELETE FROM rule WHERE name = 'Privilege Escalation Sequence'")
