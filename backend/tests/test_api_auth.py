"""Integration tests for Auth API role-aware token creation."""
from __future__ import annotations

import pytest
from sqlalchemy import select

from app.domain.models import ApiToken


pytestmark = pytest.mark.asyncio


class TestAuthAPI:
    async def test_create_user(self, client, db_session):
        resp = await client.post(
            "/api/v1/auth/users",
            json={"name": "Alice Analyst", "email": "alice@example.test", "role": "analyst", "password": "Str0ng!Pass"},
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "Alice Analyst"
        assert body["email"] == "alice@example.test"
        assert body["role"] == "analyst"

        result = await db_session.execute(select(ApiToken).where(ApiToken.user_id == body["id"], ApiToken.revoked_at.is_(None)))
        token = result.scalar_one()
        assert token.name == "alice@example.test"
        assert token.role == "analyst"

    async def test_list_users(self, client, db_session):
        await client.post(
            "/api/v1/auth/users",
            json={"name": "Alice Analyst", "email": "alice@example.test", "role": "analyst", "password": "Str0ng!Pass"},
        )
        await client.post(
            "/api/v1/auth/users",
            json={"name": "Oscar Operator", "email": "oscar@example.test", "role": "operator", "password": "Str0ng!Pass2"},
        )

        resp = await client.get("/api/v1/auth/users")
        assert resp.status_code == 200
        items = resp.json()["items"]
        assert len(items) == 2
        assert {item["role"] for item in items} == {"analyst", "operator"}

    async def test_create_token_with_role(self, client, db_session):
        resp = await client.post(
            "/api/v1/auth/token",
            json={"name": "viewer-token", "role": "viewer"},
        )
        assert resp.status_code == 201
        body = resp.json()
        assert "token" in body
        assert "token_id" in body

        result = await db_session.execute(select(ApiToken).where(ApiToken.id == body["token_id"]))
        token = result.scalar_one()
        assert token.role == "viewer"

    async def test_create_token_for_user(self, client, db_session):
        create_user = await client.post(
            "/api/v1/auth/users",
            json={"name": "Alice Analyst", "email": "alice@example.test", "role": "analyst", "password": "Str0ng!Pass"},
        )
        user_id = create_user.json()["id"]

        resp = await client.post(
            "/api/v1/auth/token",
            json={"name": "alice-token", "role": "analyst", "user_id": user_id},
        )
        assert resp.status_code == 201

        result = await db_session.execute(select(ApiToken).where(ApiToken.id == resp.json()["token_id"]))
        token = result.scalar_one()
        assert token.user_id == user_id

        active_tokens = await db_session.execute(
            select(ApiToken).where(ApiToken.user_id == user_id, ApiToken.revoked_at.is_(None))
        )
        assert len(active_tokens.scalars().all()) == 1

        revoked_tokens = await db_session.execute(
            select(ApiToken).where(ApiToken.user_id == user_id, ApiToken.revoked_at.is_not(None))
        )
        assert len(revoked_tokens.scalars().all()) == 1

    async def test_me_returns_role(self, client):
        resp = await client.get("/api/v1/auth/me")
        assert resp.status_code == 200
        assert resp.json()["role"] == "admin"

    async def test_list_tokens_returns_role_and_revocation_state(self, client, db_session):
        db_session.add_all([
            ApiToken(name="viewer-token", role="viewer", scope_json=[], token_hash="h1"),
            ApiToken(name="analyst-token", role="analyst", scope_json=["write"], token_hash="h2"),
        ])
        await db_session.commit()

        resp = await client.get("/api/v1/auth/tokens")
        assert resp.status_code == 200
        items = resp.json()["items"]
        assert len(items) == 2
        assert {item["role"] for item in items} == {"viewer", "analyst"}
        assert all("revoked_at" in item for item in items)

    async def test_revoke_token_sets_revoked_at(self, client, db_session):
        token = ApiToken(name="to-revoke", role="viewer", scope_json=[], token_hash="h3")
        db_session.add(token)
        await db_session.commit()

        resp = await client.post(f"/api/v1/auth/tokens/{token.id}/revoke")
        assert resp.status_code == 200
        assert resp.json()["revoked_at"] is not None

        result = await db_session.execute(select(ApiToken).where(ApiToken.id == token.id))
        refreshed = result.scalar_one()
        assert refreshed.revoked_at is not None

    async def test_revoke_missing_token_returns_404(self, client):
        resp = await client.post("/api/v1/auth/tokens/00000000-0000-0000-0000-000000000000/revoke")
        assert resp.status_code == 404

    async def test_login_returns_existing_token_for_valid_credentials(self, client, db_session):
        create_user = await client.post(
            "/api/v1/auth/users",
            json={"name": "Alice Analyst", "email": "alice@example.test", "role": "analyst", "password": "Str0ng!Pass"},
        )
        assert create_user.status_code == 201

        login = await client.post(
            "/api/v1/auth/login",
            json={"email": "alice@example.test", "password": "Str0ng!Pass"},
        )
        assert login.status_code == 200
        body = login.json()
        assert body["token"]
        assert body["token_id"]

        second_login = await client.post(
            "/api/v1/auth/login",
            json={"email": "alice@example.test", "password": "Str0ng!Pass"},
        )
        assert second_login.status_code == 200
        assert second_login.json() == body

        active_tokens = await db_session.execute(
            select(ApiToken).where(ApiToken.user_id == create_user.json()["id"], ApiToken.revoked_at.is_(None))
        )
        assert len(active_tokens.scalars().all()) == 1

    async def test_login_rejects_invalid_password(self, client, db_session):
        create_user = await client.post(
            "/api/v1/auth/users",
            json={"name": "Alice Analyst", "email": "alice@example.test", "role": "analyst", "password": "Str0ng!Pass"},
        )
        assert create_user.status_code == 201

        login = await client.post(
            "/api/v1/auth/login",
            json={"email": "alice@example.test", "password": "wrong-pass"},
        )
        assert login.status_code == 401