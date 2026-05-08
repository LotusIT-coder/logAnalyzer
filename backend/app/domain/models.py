"""SQLAlchemy ORM models matching db/schema.sql."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    PrimaryKeyConstraint,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class Source(Base):
    __tablename__ = "source"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(
        Text,
        CheckConstraint(
            "type IN ('file','syslog','journald','docker')"
        ),
        nullable=False,
    )
    config_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    raw_logs: Mapped[list["RawLog"]] = relationship(back_populates="source", cascade="all, delete-orphan")
    events: Mapped[list["Event"]] = relationship(back_populates="source", cascade="all, delete-orphan")


class RawLog(Base):
    __tablename__ = "raw_log"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    source_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("source.id", ondelete="CASCADE"), nullable=False)
    ingested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    raw_line: Mapped[str] = mapped_column(Text, nullable=False)
    raw_hash: Mapped[str | None] = mapped_column(Text)
    cursor: Mapped[str | None] = mapped_column(Text)

    source: Mapped["Source"] = relationship(back_populates="raw_logs")


class ParserProfile(Base):
    __tablename__ = "parser_profile"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    format: Mapped[str] = mapped_column(
        Text,
        CheckConstraint("format IN ('json','regex','grok','kv')"),
        nullable=False,
    )
    pattern: Mapped[str | None] = mapped_column(Text)
    mapping_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Event(Base):
    __tablename__ = "event"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    source_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("source.id", ondelete="CASCADE"), nullable=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    severity: Mapped[str] = mapped_column(Text, nullable=False)
    service: Mapped[str | None] = mapped_column(Text)
    host: Mapped[str | None] = mapped_column(Text)
    environment: Mapped[str | None] = mapped_column(Text)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    event_type: Mapped[str | None] = mapped_column(Text)
    fields_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    fingerprint: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    source: Mapped["Source"] = relationship(back_populates="events")
    incident_events: Mapped[list["IncidentEvent"]] = relationship(back_populates="event", cascade="all, delete-orphan")


class Rule(Base):
    __tablename__ = "rule"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    condition_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    threshold: Mapped[int] = mapped_column(Integer, CheckConstraint("threshold > 0"), nullable=False)
    window_seconds: Mapped[int] = mapped_column(Integer, CheckConstraint("window_seconds > 0"), nullable=False)
    severity: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    incidents: Mapped[list["Incident"]] = relationship(back_populates="rule")


class Incident(Base):
    __tablename__ = "incident"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        Text,
        CheckConstraint("status IN ('open','investigating','resolved','false_positive')"),
        nullable=False,
    )
    severity: Mapped[str] = mapped_column(Text, nullable=False)
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    event_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rule_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False), ForeignKey("rule.id", ondelete="SET NULL"))
    summary: Mapped[str | None] = mapped_column(Text)
    assignee: Mapped[str | None] = mapped_column(Text)
    tags_json: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    rule: Mapped["Rule | None"] = relationship(back_populates="incidents")
    incident_events: Mapped[list["IncidentEvent"]] = relationship(back_populates="incident", cascade="all, delete-orphan")


class IncidentEvent(Base):
    __tablename__ = "incident_event"
    __table_args__ = (PrimaryKeyConstraint("incident_id", "event_id"),)

    incident_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("incident.id", ondelete="CASCADE"), nullable=False)
    event_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("event.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    incident: Mapped["Incident"] = relationship(back_populates="incident_events")
    event: Mapped["Event"] = relationship(back_populates="incident_events")


class ModelProfile(Base):
    __tablename__ = "model_profile"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    purpose: Mapped[str] = mapped_column(
        Text,
        CheckConstraint("purpose IN ('triage','deep','security')"),
        nullable=False,
    )
    ollama_model: Mapped[str] = mapped_column(Text, nullable=False)
    temperature: Mapped[float] = mapped_column(Numeric(3, 2), nullable=False, default=0.20)
    max_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=1024)
    system_prompt_template: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AIAnalysis(Base):
    __tablename__ = "ai_analysis"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    target_type: Mapped[str] = mapped_column(
        Text,
        CheckConstraint("target_type IN ('window','incident','event_set')"),
        nullable=False,
    )
    target_ref: Mapped[str] = mapped_column(Text, nullable=False)
    model_name: Mapped[str] = mapped_column(Text, nullable=False)
    prompt_version: Mapped[str] = mapped_column(Text, nullable=False)
    input_digest: Mapped[str | None] = mapped_column(Text)
    result_text: Mapped[str | None] = mapped_column(Text)
    confidence: Mapped[float | None] = mapped_column(Numeric(5, 2))
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    token_usage_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())



