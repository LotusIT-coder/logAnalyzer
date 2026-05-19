"""Async Ollama HTTP client.

All communication with Ollama uses httpx to avoid blocking the event loop.
Errors from Ollama are surfaced as plain exceptions; callers decide how to handle.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, AsyncIterator, Dict, List, Optional
from urllib.parse import urlsplit, urlunsplit

import httpx

from app.config import get_settings


def _base_url() -> str:
    return get_settings().ollama_base_url.rstrip("/")


def _build_netloc(parsed, port: int | None) -> str:
    auth = ""
    if parsed.username:
        auth = parsed.username
        if parsed.password:
            auth = f"{auth}:{parsed.password}"
        auth = f"{auth}@"

    host = parsed.hostname or ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"

    if port is None:
        return f"{auth}{host}"
    return f"{auth}{host}:{port}"


def _candidate_base_urls() -> list[str]:
    configured = _base_url()
    parsed = urlsplit(configured)
    if not parsed.scheme or not parsed.hostname:
        return [configured]

    # Keep configured URL first, then try both supported Ollama ports on the
    # same host so deployments with either 11434 or 11435 work transparently.
    candidates: list[str] = [configured.rstrip("/")]
    for port in (11434, 11435):
        candidate = urlunsplit(
            (
                parsed.scheme,
                _build_netloc(parsed, port),
                parsed.path,
                "",
                "",
            )
        ).rstrip("/")
        if candidate not in candidates:
            candidates.append(candidate)
    return candidates


async def _request_with_port_fallback(
    method: str,
    path: str,
    *,
    json_payload: Dict[str, Any] | None = None,
    timeout: httpx.Timeout | float = 10,
) -> httpx.Response:
    last_exc: Exception | None = None
    for base in _candidate_base_urls():
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.request(method, f"{base}{path}", json=json_payload)
                return response
        except (httpx.ConnectError, httpx.TimeoutException) as exc:
            last_exc = exc
            continue

    if last_exc is not None:
        raise last_exc
    raise RuntimeError("Ollama request failed before attempting a connection")


async def list_models() -> List[Dict[str, Any]]:
    """Return the raw model list from Ollama /api/tags."""
    resp = await _request_with_port_fallback("GET", "/api/tags", timeout=10)
    resp.raise_for_status()
    data = resp.json()
    return data.get("models", [])


async def generate(
    model: str,
    prompt: str,
    system: Optional[str] = None,
    temperature: float = 0.2,
    max_tokens: int = 1024,
    response_format: str | None = None,
) -> str:
    """Single-shot generation via /api/generate (non-streaming)."""
    payload: Dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {
            "temperature": temperature,
            "num_predict": max_tokens,
        },
    }
    if system:
        payload["system"] = system
    if response_format:
        payload["format"] = response_format

    resp = await _request_with_port_fallback(
        "POST",
        "/api/generate",
        json_payload=payload,
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json().get("response", "")


async def chat(
    model: str,
    messages: List[Dict[str, Any]],
    temperature: float = 0.2,
    max_tokens: int = 1024,
) -> str:
    """Chat-style completion via /api/chat (non-streaming, no tools)."""
    msg = await chat_full(model, messages, temperature, max_tokens, tools=None)
    return msg.get("content", "") or ""


async def chat_full(
    model: str,
    messages: List[Dict[str, Any]],
    temperature: float = 0.2,
    max_tokens: int = 1024,
    tools: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Chat completion that returns the full assistant message dict.

    The dict may include ``tool_calls`` (list of ``{"function": {"name", "arguments"}}``)
    which the caller has to execute before sending another round.
    """
    payload: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {
            "temperature": temperature,
            "num_predict": max_tokens,
        },
    }
    if tools:
        payload["tools"] = tools
    elif model.startswith("qwen3"):
        # Disable extended thinking for qwen3 when no tools are involved.
        # Other models don't support this field and return 400.
        payload["think"] = False
    timeout = httpx.Timeout(connect=10.0, read=600.0, write=60.0, pool=60.0)
    resp = await _request_with_port_fallback(
        "POST",
        "/api/chat",
        json_payload=payload,
        timeout=timeout,
    )
    if resp.status_code == 400 and tools:
        # Model does not support function calling – retry without tools.
        # The caller already injected a baseline snapshot so the answer is
        # still grounded in real data.
        payload.pop("tools", None)
        resp = await _request_with_port_fallback(
            "POST",
            "/api/chat",
            json_payload=payload,
            timeout=timeout,
        )
    resp.raise_for_status()
    return resp.json().get("message", {}) or {}
