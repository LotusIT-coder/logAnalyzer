"""Pydantic schemas for Auth endpoints."""
from __future__ import annotations

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


TokenRole = Literal["viewer", "analyst", "operator", "admin"]


class TokenCreateRequest(BaseModel):
    name: str
    scopes: List[str] = []
    role: TokenRole = "viewer"
    user_id: Optional[str] = None
    expires_at: Optional[datetime] = None


class TokenCreateResponse(BaseModel):
    token: str
    token_id: str


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    token: str
    token_id: str


class TokenResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    name: str
    user_id: Optional[str] = None
    role: TokenRole
    scopes: List[str] = Field(validation_alias="scope_json")
    expires_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None
    created_at: datetime
    revoked_at: Optional[datetime] = None


class TokenListResponse(BaseModel):
    items: List[TokenResponse]


class MeResponse(BaseModel):
    subject: str
    user_id: Optional[str] = None
    role: TokenRole
    scopes: List[str]


class UserCreateRequest(BaseModel):
    name: str
    email: str
    password: str
    role: TokenRole = "viewer"
    enabled: bool = True


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    email: str
    role: TokenRole
    enabled: bool
    created_at: datetime
    updated_at: datetime


class UserListResponse(BaseModel):
    items: List[UserResponse]
