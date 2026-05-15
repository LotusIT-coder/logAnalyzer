"""Add geo anomaly correlation rule.

Revision ID: 0018_add_geo_anomaly_rule
Revises: 0017_add_privilege_escalation_sequence_rule
Create Date: 2026-05-15 09:40:00
"""

from alembic import op


# revision identifiers, used by Alembic.
revision = "0018_add_geo_anomaly_rule"
down_revision = "0017_priv_esc_seq_rule"
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
            'Geo Anomaly Login',
            'Detects login_success from unseen country/asn per user using short-term baseline',
            '{
              "type": "geo_anomaly",
              "entity_field": "username",
              "location_fields": ["country", "asn"],
              "min_history_events": 3,
              "min_distinct_locations": 1,
              "baseline_exclude_recent": 1
            }'::jsonb,
            NULL,
            'username',
            1,
            86400,
            'high',
            true
        WHERE NOT EXISTS (
            SELECT 1 FROM rule WHERE name = 'Geo Anomaly Login'
        )
        """
    )


def downgrade() -> None:
    op.execute("DELETE FROM rule WHERE name = 'Geo Anomaly Login'")
