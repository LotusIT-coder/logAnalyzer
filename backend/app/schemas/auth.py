"""Pydantic schemas for Auth endpoints."""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel


class TokenCreateRequest(BaseModel):
    name: str
    scopes: List[str]
    expires_at: Optional[datetime] = None


class TokenCreateResponse(BaseModel):
    token: str
    token_id: str


class MeResponse(BaseModel):
    subject: str
    scopes: List[str]
