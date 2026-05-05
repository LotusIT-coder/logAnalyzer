"""Auth endpoints – POST /token, GET /me.

Notes:
- POST /api/v1/auth/login is NOT implemented (MVP uses API tokens only, no user/password login).
  The endpoint is reserved in the spec; calling it returns 501.
- POST /api/v1/auth/token creates a new API token (requires admin scope).
- GET  /api/v1/auth/me returns the current token's subject and scopes.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import generate_raw_token, get_current_token, hash_token, require_scope
from app.config import get_settings
from app.dependencies import get_db
from app.domain.models import ApiToken
from app.schemas.auth import MeResponse, TokenCreateRequest, TokenCreateResponse

router = APIRouter(prefix="/auth", tags=["Auth"])


@router.post("/login", status_code=status.HTTP_501_NOT_IMPLEMENTED)
async def login():
    """Password login is not implemented in MVP (API-Token only)."""
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Password login is not available. Use API tokens.",
    )


@router.post("/token", response_model=TokenCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_token(
    body: TokenCreateRequest,
    _token=Depends(require_scope("admin")),
    session: AsyncSession = Depends(get_db),
    settings=Depends(get_settings),
):
    """Create a new API token. Requires admin scope. Token value shown once."""
    raw = generate_raw_token()
    token_hash = hash_token(raw, settings.api_token_signing_key)

    api_token = ApiToken(
        name=body.name,
        scope_json=body.scopes,
        token_hash=token_hash,
        expires_at=body.expires_at,
    )
    session.add(api_token)
    await session.flush()
    await session.refresh(api_token)

    return TokenCreateResponse(token=raw, token_id=api_token.id)


@router.get("/me", response_model=MeResponse)
async def me(token=Depends(get_current_token)):
    """Return the current token's name (subject) and granted scopes."""
    return MeResponse(subject=token.name, scopes=token.scope_json or [])
