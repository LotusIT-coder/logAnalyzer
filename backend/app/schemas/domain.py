"""Pydantic schemas for Rules, Incidents, AI, Metrics, Audit."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------

class RuleResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    name: str
    description: Optional[str] = None
    condition: Dict[str, Any] = Field(validation_alias="condition_json")
    threshold: int
    window_seconds: int
    severity: str
    enabled: bool
    created_at: datetime
    updated_at: datetime


class RuleListResponse(BaseModel):
    items: List[RuleResponse]


class RuleCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    condition: Dict[str, Any]
    threshold: int = Field(ge=1)
    window_seconds: int = Field(ge=1)
    severity: str
    enabled: bool = True


class RulePatchRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    condition: Optional[Dict[str, Any]] = None
    threshold: Optional[int] = Field(None, ge=1)
    window_seconds: Optional[int] = Field(None, ge=1)
    severity: Optional[str] = None
    enabled: Optional[bool] = None


class RuleDryRunRequest(BaseModel):
    from_: Optional[datetime] = Field(None, alias="from")
    to: Optional[datetime] = None

    model_config = ConfigDict(populate_by_name=True)


class RuleDryRunResponse(BaseModel):
    matched_events: int
    would_create_incident: bool


# ---------------------------------------------------------------------------
# Incidents
# ---------------------------------------------------------------------------

class IncidentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    title: str
    status: str
    severity: str
    first_seen: datetime
    last_seen: datetime
    event_count: int
    rule_id: Optional[str] = None
    summary: Optional[str] = None
    assignee: Optional[str] = None
    tags: List[str] = Field(validation_alias="tags_json")
    created_at: datetime
    updated_at: datetime


class IncidentListResponse(BaseModel):
    items: List[IncidentResponse]


class IncidentPatchRequest(BaseModel):
    status: Optional[str] = None
    summary: Optional[str] = None
    assignee: Optional[str] = None
    tags: Optional[List[str]] = None


# ---------------------------------------------------------------------------
# AI
# ---------------------------------------------------------------------------

class AIModelResponse(BaseModel):
    name: str
    size: Optional[str] = None
    family: Optional[str] = None
    modified_at: Optional[datetime] = None


class AIModelListResponse(BaseModel):
    items: List[AIModelResponse]


class AsyncJobAccepted(BaseModel):
    job_id: str
    status: str = "queued"


class AIJob(BaseModel):
    id: str
    status: str
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class AIAnalyzeWindowRequest(BaseModel):
    from_: datetime = Field(alias="from")
    to: datetime
    model_profile_id: Optional[str] = None
    max_events: int = Field(500, ge=1, le=5000)

    model_config = ConfigDict(populate_by_name=True)


class AIAnalyzeIncidentRequest(BaseModel):
    model_profile_id: Optional[str] = None


class AIChatRequest(BaseModel):
    message: str
    model: Optional[str] = None          # direct Ollama model name (e.g. "qwen3:6b")
    model_profile_id: Optional[str] = None
    context: Optional[Dict[str, Any]] = None


class AIChatResponse(BaseModel):
    answer: str
    references: List[str] = []


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

class TimeseriesPoint(BaseModel):
    ts: datetime
    count: int


class TimeseriesResponse(BaseModel):
    points: List[TimeseriesPoint]


class TopErrorItem(BaseModel):
    key: str
    count: int


class TopErrorsResponse(BaseModel):
    items: List[TopErrorItem]


class TopServiceItem(BaseModel):
    service: str
    count: int


class TopServicesResponse(BaseModel):
    items: List[TopServiceItem]


class ErrorRateResponse(BaseModel):
    total_events: int
    error_events: int
    error_rate: float


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------

class AuditLogResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    actor: str
    action: str
    resource: str
    status: str
    metadata: Dict[str, Any] = Field(validation_alias="meta_json")
    created_at: datetime


class AuditListResponse(BaseModel):
    items: List[AuditLogResponse]
