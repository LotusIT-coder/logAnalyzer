"""Add network ingest foundation tables.

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-07
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0005"
down_revision: str | None = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_source_type", "source", type_="check")
    op.create_check_constraint(
        "ck_source_type",
        "source",
        "type IN ('file','syslog','journald','docker','netflow','sflow','socket_observer','packet_capture')",
    )

    op.create_table(
        "network_flow",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("source_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("source.id", ondelete="CASCADE"), nullable=False),
        sa.Column("collector_node_id", sa.Text()),
        sa.Column("telemetry_type", sa.Text(), nullable=False),
        sa.Column("observed_at_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("observed_at_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("host_id", sa.Text()),
        sa.Column("exporter_addr", postgresql.INET()),
        sa.Column("observation_domain_id", sa.BigInteger()),
        sa.Column("src_ip", postgresql.INET(), nullable=False),
        sa.Column("dst_ip", postgresql.INET(), nullable=False),
        sa.Column("src_port", sa.Integer()),
        sa.Column("dst_port", sa.Integer()),
        sa.Column("protocol", sa.Text(), nullable=False),
        sa.Column("bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("packets", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("connections", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("direction", sa.Text()),
        sa.Column("action", sa.Text()),
        sa.Column("app_hint", sa.Text()),
        sa.Column("process_name", sa.Text()),
        sa.Column("sample_factor", sa.Numeric(12, 4), nullable=False, server_default="1.0"),
        sa.Column("confidence", sa.Numeric(5, 4), nullable=False, server_default="1.0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint(
            "telemetry_type IN ('netflow','ipfix','sflow','socket_observer')",
            name="ck_network_flow_telemetry_type",
        ),
    )
    op.create_index("idx_network_flow_observed_at_end", "network_flow", [sa.text("observed_at_end DESC")])
    op.create_index("idx_network_flow_source_id_time", "network_flow", ["source_id", sa.text("observed_at_end DESC")])
    op.create_index("idx_network_flow_src_ip_time", "network_flow", ["src_ip", sa.text("observed_at_end DESC")])
    op.create_index("idx_network_flow_dst_ip_time", "network_flow", ["dst_ip", sa.text("observed_at_end DESC")])
    op.create_index("idx_network_flow_protocol_port", "network_flow", ["protocol", "dst_port"])
    op.create_index("idx_network_flow_host_process", "network_flow", ["host_id", "process_name"])

    op.create_table(
        "network_ingest_batch",
        sa.Column("batch_id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("collector_node_id", sa.Text(), nullable=False),
        sa.Column("source_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("source.id", ondelete="CASCADE"), nullable=False),
        sa.Column("telemetry_type", sa.Text(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("item_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error_text", sa.Text()),
        sa.CheckConstraint(
            "telemetry_type IN ('netflow','ipfix','sflow','socket_observer')",
            name="ck_network_ingest_batch_telemetry_type",
        ),
        sa.CheckConstraint(
            "status IN ('accepted','rejected')",
            name="ck_network_ingest_batch_status",
        ),
    )
    op.create_index(
        "idx_network_ingest_batch_source_received",
        "network_ingest_batch",
        ["source_id", sa.text("received_at DESC")],
    )
    op.create_index(
        "idx_network_ingest_batch_status_received",
        "network_ingest_batch",
        ["status", sa.text("received_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("idx_network_ingest_batch_status_received", table_name="network_ingest_batch")
    op.drop_index("idx_network_ingest_batch_source_received", table_name="network_ingest_batch")
    op.drop_table("network_ingest_batch")

    op.drop_index("idx_network_flow_host_process", table_name="network_flow")
    op.drop_index("idx_network_flow_protocol_port", table_name="network_flow")
    op.drop_index("idx_network_flow_dst_ip_time", table_name="network_flow")
    op.drop_index("idx_network_flow_src_ip_time", table_name="network_flow")
    op.drop_index("idx_network_flow_source_id_time", table_name="network_flow")
    op.drop_index("idx_network_flow_observed_at_end", table_name="network_flow")
    op.drop_table("network_flow")

    op.drop_constraint("ck_source_type", "source", type_="check")
    op.create_check_constraint(
        "ck_source_type",
        "source",
        "type IN ('file','syslog','journald','docker')",
    )
