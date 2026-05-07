"""Auth helpers: token hashing, verification, and scope enforcement."""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import Depends, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.dependencies import get_db
from app.domain.models import ApiToken

_bearer_scheme = HTTPBearer(auto_error=False)
_password_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")
_TOKEN_PREFIX = "lat"
_ROLE_SCOPE_GRANTS = {
    "viewer": {"read"},
    "analyst": {"read", "write"},
    "operator": {"read", "write"},
    "admin": {"admin", "read", "write"},
}


def hash_token(raw_token: str, signing_key: str) -> str:
    """HMAC-SHA256 hash of a raw token. Stored in DB, never the raw value."""
    return hmac.new(
        signing_key.encode(),
        raw_token.encode(),
        digestmod=hashlib.sha256,
    ).hexdigest()


def generate_raw_token() -> str:
    return secrets.token_urlsafe(40)


def issue_token(token_id: str, signing_key: str) -> str:
    digest = hmac.new(
        signing_key.encode(),
        token_id.encode(),
        digestmod=hashlib.sha256,
    ).digest()
    signature = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return f"{_TOKEN_PREFIX}_{token_id}.{signature}"


def resolve_token_id(raw_token: str, signing_key: str) -> str | None:
    prefix = f"{_TOKEN_PREFIX}_"
    if not raw_token.startswith(prefix):
        return None

    token_payload = raw_token[len(prefix):]
    token_id, separator, signature = token_payload.partition(".")
    if not separator or not token_id or not signature:
        return None

    expected_signature = issue_token(token_id, signing_key).partition(".")[2]
    if not hmac.compare_digest(signature, expected_signature):
        return None

    return token_id


def hash_password(password: str) -> str:
    return _password_context.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    if not password_hash:
        return False
    return _password_context.verify(password, password_hash)


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

    If DISABLE_AUTH=true (env), all requests are accepted without a token.
    """
    if settings.disable_auth:
        # Return a synthetic in-memory token with full admin scope
        dummy = ApiToken(
            id="00000000-0000-0000-0000-000000000000",
            name="no-auth",
            role="admin",
            scope_json=["admin", "read", "write"],
            token_hash="no-auth",
        )
        return dummy
    # Resolve raw token from header or query param
    if credentials is not None:
        raw = credentials.credentials
    elif token_query:
        raw = token_query
    else:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated.")
    token_id = resolve_token_id(raw, settings.api_token_signing_key)
    if token_id is not None:
        result = await session.execute(
            select(ApiToken).where(
                ApiToken.id == token_id,
                ApiToken.revoked_at.is_(None),
            )
        )
    else:
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


def _effective_scopes(token: ApiToken) -> set[str]:
    scopes: set[str] = set(token.scope_json or [])
    scopes.update(_ROLE_SCOPE_GRANTS.get(getattr(token, "role", "viewer") or "viewer", set()))
    return scopes


def require_scope(required: str):
    """Dependency factory: raises 403 if token lacks required scope."""

    def _check(token: ApiToken = Depends(get_current_token)) -> ApiToken:
        scopes = _effective_scopes(token)
        if required not in scopes and "admin" not in scopes:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Scope '{required}' required.",
            )
        return token

    return _check
