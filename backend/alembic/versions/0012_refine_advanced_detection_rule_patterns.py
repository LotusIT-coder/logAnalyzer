"""Refine advanced detection rules with multi-pattern matching.

Revision ID: 0012
Revises: 0011
Create Date: 2026-05-15
"""
from __future__ import annotations

from alembic import op


revision: str = "0012"
down_revision: str | None = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE rule
        SET condition_json = '{
          "message_contains_any": ["4769", "kerberoast", "krbtgt", "rc4-hmac"]
        }'::jsonb
        WHERE name = 'Kerberoasting Indicators'
          AND condition_json = '{"message_contains": "4769"}'::jsonb
        """
    )

    op.execute(
        """
        UPDATE rule
        SET condition_json = '{
          "message_contains_any": [
            "powershell -enc",
            "-encodedcommand",
            "invoke-expression",
            "iex(",
            "frombase64string",
            "downloadstring("
          ]
        }'::jsonb
        WHERE name = 'Suspicious PowerShell'
          AND condition_json = '{"message_contains": "powershell -enc"}'::jsonb
        """
    )

    op.execute(
        """
        UPDATE rule
        SET condition_json = '{
          "message_contains_any": [
            "scheduled task",
            "schtasks /create",
            "new-service",
            "run key",
            "startup folder"
          ]
        }'::jsonb
        WHERE name = 'Persistence Indicators'
          AND condition_json = '{"message_contains": "scheduled task"}'::jsonb
        """
    )

    op.execute(
        """
        UPDATE rule
        SET condition_json = '{
          "message_contains_any": [
            "service account",
            "logon type 2",
            "logon type 10",
            "runas /user",
            "interactive logon"
          ]
        }'::jsonb
        WHERE name = 'Service Account Abuse'
          AND condition_json = '{"message_contains": "service account"}'::jsonb
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE rule
        SET condition_json = '{"message_contains": "4769"}'::jsonb
        WHERE name = 'Kerberoasting Indicators'
          AND condition_json = '{
            "message_contains_any": ["4769", "kerberoast", "krbtgt", "rc4-hmac"]
          }'::jsonb
        """
    )

    op.execute(
        """
        UPDATE rule
        SET condition_json = '{"message_contains": "powershell -enc"}'::jsonb
        WHERE name = 'Suspicious PowerShell'
          AND condition_json = '{
            "message_contains_any": [
              "powershell -enc",
              "-encodedcommand",
              "invoke-expression",
              "iex(",
              "frombase64string",
              "downloadstring("
            ]
          }'::jsonb
        """
    )

    op.execute(
        """
        UPDATE rule
        SET condition_json = '{"message_contains": "scheduled task"}'::jsonb
        WHERE name = 'Persistence Indicators'
          AND condition_json = '{
            "message_contains_any": [
              "scheduled task",
              "schtasks /create",
              "new-service",
              "run key",
              "startup folder"
            ]
          }'::jsonb
        """
    )

    op.execute(
        """
        UPDATE rule
        SET condition_json = '{"message_contains": "service account"}'::jsonb
        WHERE name = 'Service Account Abuse'
          AND condition_json = '{
            "message_contains_any": [
              "service account",
              "logon type 2",
              "logon type 10",
              "runas /user",
              "interactive logon"
            ]
          }'::jsonb
        """
    )
