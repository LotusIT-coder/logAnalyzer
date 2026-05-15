"""Add suspicious PowerShell chain correlation rule.

Revision ID: 0019_add_suspicious_powershell_chain_rule
Revises: 0018_add_geo_anomaly_rule
Create Date: 2026-05-15 10:20:00
"""

from alembic import op


revision = "0019_susp_pwsh_chain_rule"
down_revision = "0018_add_geo_anomaly_rule"
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
            'Suspicious PowerShell Chain',
            'Correlates encoded/hidden PowerShell execution followed by suspicious child execution.',
            '{}'::jsonb,
            '[
              {
                "message_contains_any": [
                  "powershell -enc",
                  "-encodedcommand",
                  "-windowstyle hidden",
                  "frombase64string",
                  "iex("
                ]
              },
              {
                "message_contains_any": [
                  "downloadstring(",
                  "invoke-webrequest",
                  "new-object net.webclient",
                  "start-process",
                  "rundll32",
                  "regsvr32",
                  "mshta"
                ]
              }
            ]'::jsonb,
            'host',
            1,
            900,
            'high',
            true
        WHERE NOT EXISTS (
            SELECT 1 FROM rule WHERE name = 'Suspicious PowerShell Chain'
        )
        """
    )


def downgrade() -> None:
    op.execute("DELETE FROM rule WHERE name = 'Suspicious PowerShell Chain'")
