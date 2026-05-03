"""Auth helpers: token hashing, verification, and scope enforcement."""
from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import Depends, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.dependencies import get_db
from app.domain.models import ApiToken

_bearer_scheme = HTTPBearer(auto_error=False)


def hash_token(raw_token: str, signing_key: str) -> str:
    """HMAC-SHA256 hash of a raw token. Stored in DB, never the raw value."""
    return hmac.new(
        signing_key.encode(),
        raw_token.encode(),
        digestmod=hashlib.sha256,
    ).hexdigest()


def generate_raw_token() -> str:
    return secrets.token_urlsafe(40)


async def get_current_token(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer_scheme),
    token_query: Optional[str] = Query(None, alias="token"),
    session: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ApiToken:
    """Validate Bearer token against DB.

    Accepts token via:
    - Authorization: Bearer <token>  header  (normal API calls)
    - ?token=<token>                 query   (EventSource / SSE, can't set headers)
    """
    # Resolve raw token from header or query param
    if credentials is not None:
        raw = credentials.credentials
    elif token_query:
        raw = token_query
    else:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated.")
    token_hash = hash_token(raw, settings.api_token_signing_key)

    result = await session.execute(
        select(ApiToken).where(
            ApiToken.token_hash == token_hash,
            ApiToken.revoked_at.is_(None),
        )
    )
    token_obj = result.scalar_one_or_none()

    if token_obj is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or revoked token.")

    now = datetime.now(timezone.utc)
    if token_obj.expires_at and token_obj.expires_at < now:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired.")

    # Update last_used_at without blocking
    token_obj.last_used_at = now
    session.add(token_obj)

    return token_obj


def require_scope(required: str):
    """Dependency factory: raises 403 if token lacks required scope."""

    def _check(token: ApiToken = Depends(get_current_token)) -> ApiToken:
        scopes: List[str] = token.scope_json or []
        if required not in scopes and "admin" not in scopes:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Scope '{required}' required.",
            )
        return token

    return _check
