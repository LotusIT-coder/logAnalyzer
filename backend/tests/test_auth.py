"""Integration tests for the Auth module.

Tests the hash_token / generate_raw_token helpers and the
disable_auth bypass behaviour — without a real DB connection.
"""
from __future__ import annotations

import pytest
from app.auth import hash_token, generate_raw_token


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
