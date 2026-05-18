"""Async Ollama HTTP client.

All communication with Ollama uses httpx to avoid blocking the event loop.
Errors from Ollama are surfaced as plain exceptions; callers decide how to handle.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from app.config import get_settings


def _base_url() -> str:
    return get_settings().ollama_base_url.rstrip("/")


async def list_models() -> List[Dict[str, Any]]:
    """Return the raw model list from Ollama /api/tags."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{_base_url()}/api/tags")
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

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(f"{_base_url()}/api/generate", json=payload)
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
    else:
        # Disable extended thinking only when no tools are involved.
        # qwen3 needs internal reasoning to pick tools correctly.
        payload["think"] = False
    timeout = httpx.Timeout(connect=10.0, read=600.0, write=60.0, pool=60.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(f"{_base_url()}/api/chat", json=payload)
        resp.raise_for_status()
        return resp.json().get("message", {}) or {}
