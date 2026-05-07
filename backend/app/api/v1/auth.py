"""Auth endpoints – password login, token assignment, and current principal."""
from __future__ import annotations

from datetime import datetime, timezone
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_token, hash_password, hash_token, issue_token, require_scope, verify_password
from app.config import get_settings
from app.dependencies import get_db
from app.domain.models import ApiToken, User
from app.schemas.auth import (
    LoginRequest,
    LoginResponse,
    MeResponse,
    TokenCreateRequest,
    TokenCreateResponse,
    TokenListResponse,
    TokenResponse,
    UserCreateRequest,
    UserListResponse,
    UserResponse,
)

router = APIRouter(prefix="/auth", tags=["Auth"])


def _new_api_token(*, name: str, role: str, signing_key: str, user_id: str | None = None, scopes: list[str] | None = None, expires_at=None) -> tuple[ApiToken, str]:
    token_id = str(uuid.uuid4())
    raw = issue_token(token_id, signing_key)
    api_token = ApiToken(
        id=token_id,
        name=name,
        user_id=user_id,
        role=role,
        scope_json=scopes or [],
        token_hash=hash_token(raw, signing_key),
        expires_at=expires_at,
    )
    return api_token, raw


@router.post("/login", response_model=LoginResponse)
async def login(
    body: LoginRequest,
    session: AsyncSession = Depends(get_db),
    settings=Depends(get_settings),
):
    user_result = await session.execute(select(User).where(User.email == body.email))
    user = user_result.scalar_one_or_none()
    if user is None or not user.enabled or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password.")

    token_result = await session.execute(
        select(ApiToken)
        .where(ApiToken.user_id == user.id, ApiToken.revoked_at.is_(None))
        .order_by(ApiToken.created_at.desc())
    )
    api_token = token_result.scalars().first()

    if api_token is None:
        api_token, raw = _new_api_token(
            name=user.email,
            user_id=user.id,
            role=user.role,
            scopes=[],
            signing_key=settings.api_token_signing_key,
        )
        session.add(api_token)
        await session.flush()
        await session.refresh(api_token)
        return LoginResponse(token=raw, token_id=api_token.id)

    raw = issue_token(api_token.id, settings.api_token_signing_key)
    deterministic_hash = hash_token(raw, settings.api_token_signing_key)
    if api_token.token_hash != deterministic_hash:
        api_token.token_hash = deterministic_hash
        session.add(api_token)
        await session.flush()
        await session.refresh(api_token)

    return LoginResponse(token=raw, token_id=api_token.id)


@router.post("/token", response_model=TokenCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_token(
    body: TokenCreateRequest,
    _token=Depends(require_scope("admin")),
    session: AsyncSession = Depends(get_db),
    settings=Depends(get_settings),
):
    if body.user_id is not None:
        user_result = await session.execute(select(User).where(User.id == body.user_id))
        if user_result.scalar_one_or_none() is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")

        active_tokens = await session.execute(
            select(ApiToken)
            .where(ApiToken.user_id == body.user_id, ApiToken.revoked_at.is_(None))
            .order_by(ApiToken.created_at.desc())
        )
        for active_token in active_tokens.scalars():
            active_token.revoked_at = datetime.now(timezone.utc)
            session.add(active_token)

    api_token, raw = _new_api_token(
        name=body.name,
        user_id=body.user_id,
        role=body.role,
        scopes=body.scopes,
        expires_at=body.expires_at,
        signing_key=settings.api_token_signing_key,
    )
    session.add(api_token)
    await session.flush()
    await session.refresh(api_token)

    return TokenCreateResponse(token=raw, token_id=api_token.id)


@router.get("/tokens", response_model=TokenListResponse)
async def list_tokens(
    _token=Depends(require_scope("admin")),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(ApiToken).order_by(ApiToken.created_at.desc()))
    return TokenListResponse(items=[TokenResponse.model_validate(token) for token in result.scalars()])


@router.post("/tokens/{token_id}/revoke", response_model=TokenResponse)
async def revoke_token(
    token_id: str,
    _token=Depends(require_scope("admin")),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(ApiToken).where(ApiToken.id == token_id))
    token = result.scalar_one_or_none()
    if token is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Token not found.")

    if token.revoked_at is None:
        token.revoked_at = datetime.now(timezone.utc)
        session.add(token)
        await session.flush()
        await session.refresh(token)

    return TokenResponse.model_validate(token)


@router.post("/users", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: UserCreateRequest,
    _token=Depends(require_scope("admin")),
    session: AsyncSession = Depends(get_db),
):
    user = User(
        name=body.name,
        email=body.email,
        password_hash=hash_password(body.password),
        role=body.role,
        enabled=body.enabled,
    )
    session.add(user)
    await session.flush()

    initial_token, _ = _new_api_token(
        name=user.email,
        user_id=user.id,
        role=user.role,
        scopes=[],
        signing_key=get_settings().api_token_signing_key,
    )
    session.add(initial_token)
    await session.flush()
    await session.refresh(user)
    return UserResponse.model_validate(user)


@router.get("/users", response_model=UserListResponse)
async def list_users(
    _token=Depends(require_scope("admin")),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(User).order_by(User.created_at.asc()))
    return UserListResponse(items=[UserResponse.model_validate(user) for user in result.scalars()])


@router.get("/me", response_model=MeResponse)
async def me(token=Depends(get_current_token)):
    """Return the current token's name (subject) and granted scopes."""
    return MeResponse(subject=token.name, user_id=token.user_id, role=token.role, scopes=token.scope_json or [])
