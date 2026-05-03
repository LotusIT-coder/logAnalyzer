"""Pydantic schemas for Event endpoints."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


class EventResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    source_id: str
    timestamp: datetime
    severity: str
    service: Optional[str] = None
    host: Optional[str] = None
    environment: Optional[str] = None
    event_type: Optional[str] = None
    message: str
    fields: Dict[str, Any] = Field(validation_alias="fields_json")
    fingerprint: Optional[str] = None
    created_at: datetime


class EventListResponse(BaseModel):
    items: List[EventResponse]
    next_cursor: Optional[str] = None


class ParserTestRequest(BaseModel):
    parser_profile_id: Optional[str] = None
    sample_lines: List[str]


class ParserTestResponse(BaseModel):
    matched: int
    total: int
    preview_events: List[Dict[str, Any]]
