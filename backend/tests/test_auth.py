"""Integration tests for the Auth module.

Tests the hash_token / generate_raw_token helpers and the
disable_auth bypass behaviour — without a real DB connection.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.auth import generate_raw_token, hash_token, hash_password, require_scope, verify_password
from app.domain.models import ApiToken


class TestTokenHashing:
    def test_hash_is_deterministic(self):
        h1 = hash_token("mytoken", "signing-key")
        h2 = hash_token("mytoken", "signing-key")
        assert h1 == h2

    def test_different_token_different_hash(self):
        h1 = hash_token("token-a", "signing-key")
        h2 = hash_token("token-b", "signing-key")
        assert h1 != h2

    def test_different_signing_key_different_hash(self):
        h1 = hash_token("mytoken", "key1")
        h2 = hash_token("mytoken", "key2")
        assert h1 != h2

    def test_hash_is_hex_string(self):
        h = hash_token("any", "key")
        assert isinstance(h, str)
        assert len(h) == 64  # SHA-256 produces 32 bytes = 64 hex chars
        int(h, 16)  # must be valid hex

    def test_generate_raw_token_is_url_safe(self):
        token = generate_raw_token()
        assert isinstance(token, str)
        assert len(token) > 20
        # url-safe base64 chars only
        import re
        assert re.fullmatch(r"[A-Za-z0-9_\-]+", token)

    def test_generate_raw_token_is_unique(self):
        tokens = {generate_raw_token() for _ in range(50)}
        assert len(tokens) == 50


class TestPasswordHashing:
    def test_password_hash_verifies_plaintext(self):
        password_hash = hash_password("Str0ng!Pass")

        assert verify_password("Str0ng!Pass", password_hash) is True

    def test_password_hash_rejects_wrong_plaintext(self):
        password_hash = hash_password("Str0ng!Pass")

        assert verify_password("wrong-pass", password_hash) is False


class TestDisableAuthEndpoint:
    """Smoke test: with DISABLE_AUTH=true the API accepts requests without a token."""

    @pytest.mark.asyncio
    async def test_sources_accessible_without_token(self, client):
        resp = await client.get("/api/v1/sources")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_rules_accessible_without_token(self, client):
        resp = await client.get("/api/v1/rules")
        assert resp.status_code == 200


class TestRoleBasedAuthorization:
    def test_viewer_role_allows_read(self):
        checker = require_scope("read")
        token = ApiToken(name="viewer", role="viewer", scope_json=[], token_hash="x")

        assert checker(token) is token

    def test_viewer_role_blocks_write(self):
        checker = require_scope("write")
        token = ApiToken(name="viewer", role="viewer", scope_json=[], token_hash="x")

        with pytest.raises(HTTPException) as exc:
            checker(token)

        assert exc.value.status_code == 403

    def test_admin_role_allows_admin_scope_without_explicit_scope_json(self):
        checker = require_scope("admin")
        token = ApiToken(name="admin", role="admin", scope_json=[], token_hash="x")

        assert checker(token) is token
