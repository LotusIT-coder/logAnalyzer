"""
Shared pytest fixtures for the LogAnalyzer test suite.

Database strategy: SQLite in-memory via aiosqlite (no PostgreSQL needed for tests).
All fixtures use function scope so each test gets a clean state.
"""
from __future__ import annotations

import os
import pytest
import pytest_asyncio
from typing import AsyncGenerator

# Force test settings BEFORE any app import resolves get_settings()
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("DISABLE_AUTH", "true")
os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("OLLAMA_BASE_URL", "http://localhost:11434")
os.environ.setdefault("API_TOKEN_SIGNING_KEY", "test-signing-key-not-secret")
os.environ.setdefault("CORS_ALLOWED_ORIGINS", "http://localhost:5173")

from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy import JSON
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from httpx import AsyncClient, ASGITransport

# Patch JSONB → JSON for SQLite compatibility (models use JSONB for PostgreSQL).
# This must happen BEFORE app.domain.models is imported.
import sqlalchemy.dialects.postgresql as _pg
_pg.JSONB = JSON  # type: ignore[attr-defined]

from sqlalchemy.pool import StaticPool
from app.db.session import Base
from app.main import create_app
from app.dependencies import get_db


# ---------------------------------------------------------------------------
# In-memory SQLite engine + session
# ---------------------------------------------------------------------------

# URL for a single shared in-memory SQLite DB across all connections in a test.
_SQLITE_URL = "sqlite+aiosqlite:///:memory:"


@pytest_asyncio.fixture()
async def engine():
    """Create a fresh SQLite in-memory engine with all tables.

    StaticPool ensures all connections (test session + ASGI handler sessions)
    share the same in-memory database within one test function.
    """
    eng = create_async_engine(
        _SQLITE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture()
async def db_session(engine) -> AsyncGenerator[AsyncSession, None]:
    """Provide an async DB session bound to the test engine."""
    factory = async_sessionmaker(bind=engine, expire_on_commit=False, class_=AsyncSession)
    async with factory() as session:
        yield session


# ---------------------------------------------------------------------------
# FastAPI test client (ASGI transport, no running server needed)
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture()
async def client(engine) -> AsyncGenerator[AsyncClient, None]:
    """HTTP test client with dependency-injected test DB session."""
    app = create_app()

    # Override the DB session dependency
    factory = async_sessionmaker(bind=engine, expire_on_commit=False, class_=AsyncSession)

    async def override_get_db() -> AsyncGenerator[AsyncSession, None]:
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = override_get_db

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as ac:
        yield ac
