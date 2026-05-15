"""Add advanced detection baseline rules.

Revision ID: 0011
Revises: 0010
Create Date: 2026-05-15
"""
from __future__ import annotations

from alembic import op


revision: str = "0011"
down_revision: str | None = "0010"
branch_labels = None
depends_on = None


_RULE_NAMES = (
    "Kerberoasting Indicators",
    "Suspicious PowerShell",
    "Persistence Indicators",
    "Service Account Abuse",
)


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO rule (id, name, description, condition_json, threshold, window_seconds, severity, enabled)
        SELECT
            gen_random_uuid(),
            'Kerberoasting Indicators',
            'Detects bursts of Kerberos service ticket requests often linked to kerberoasting activity.',
            '{"message_contains": "4769"}'::jsonb,
            5,
            600,
            'high',
            true
        WHERE NOT EXISTS (
            SELECT 1 FROM rule WHERE name = 'Kerberoasting Indicators'
        )
        """
    )

    op.execute(
        """
        INSERT INTO rule (id, name, description, condition_json, threshold, window_seconds, severity, enabled)
        SELECT
            gen_random_uuid(),
            'Suspicious PowerShell',
            'Detects potentially malicious PowerShell execution patterns (encoded/hidden commands).',
            '{"message_contains": "powershell -enc"}'::jsonb,
            1,
            900,
            'high',
            true
        WHERE NOT EXISTS (
            SELECT 1 FROM rule WHERE name = 'Suspicious PowerShell'
        )
        """
    )

    op.execute(
        """
        INSERT INTO rule (id, name, description, condition_json, threshold, window_seconds, severity, enabled)
        SELECT
            gen_random_uuid(),
            'Persistence Indicators',
            'Detects persistence-related activity such as scheduled task creation in host telemetry.',
            '{"message_contains": "scheduled task"}'::jsonb,
            2,
            1800,
            'warning',
            true
        WHERE NOT EXISTS (
            SELECT 1 FROM rule WHERE name = 'Persistence Indicators'
        )
        """
    )

    op.execute(
        """
        INSERT INTO rule (id, name, description, condition_json, threshold, window_seconds, severity, enabled)
        SELECT
            gen_random_uuid(),
            'Service Account Abuse',
            'Detects suspicious interactive/service-account style activity in authentication logs.',
            '{"message_contains": "service account"}'::jsonb,
            2,
            900,
            'high',
            true
        WHERE NOT EXISTS (
            SELECT 1 FROM rule WHERE name = 'Service Account Abuse'
        )
        """
    )


def downgrade() -> None:
    joined = ", ".join(f"'{name}'" for name in _RULE_NAMES)
    op.execute(f"DELETE FROM rule WHERE name IN ({joined})")
