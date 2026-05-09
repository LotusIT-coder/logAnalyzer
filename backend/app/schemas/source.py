"""Pydantic schemas for Source endpoints – matches spec/openapi.v1.yaml."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


SourceType = Literal["file", "syslog", "journald", "docker"]


class SourceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    name: str
    type: SourceType
    # validation_alias reads from ORM attribute `config_json`; serialized as `config`
    config: Dict[str, Any] = Field(validation_alias="config_json")
    enabled: bool
    created_at: datetime
    updated_at: datetime


class SourceListResponse(BaseModel):
    items: List[SourceResponse]


class SourceCreateRequest(BaseModel):
    name: str
    type: SourceType
    config: Dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True


class SourcePatchRequest(BaseModel):
    name: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    enabled: Optional[bool] = None


class SourceTestResponse(BaseModel):
    ok: bool
    details: Optional[str] = None


class SourceIngestionStatusResponse(BaseModel):
    source_id: str
    last_ingested_at: Optional[datetime] = None
    last_event_timestamp: Optional[datetime] = None
    last_event_created_at: Optional[datetime] = None


class SourceIngestionStatusListResponse(BaseModel):
    items: List[SourceIngestionStatusResponse]
