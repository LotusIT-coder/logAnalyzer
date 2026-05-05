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

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(f"{_base_url()}/api/generate", json=payload)
        resp.raise_for_status()
        return resp.json().get("response", "")


async def chat(
    model: str,
    messages: List[Dict[str, str]],
    temperature: float = 0.2,
    max_tokens: int = 1024,
) -> str:
    """Chat-style completion via /api/chat (non-streaming)."""
    payload: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": False,
        "think": False,  # disable extended thinking for qwen3 and similar models
        "options": {
            "temperature": temperature,
            "num_predict": max_tokens,
        },
    }
    timeout = httpx.Timeout(connect=10.0, read=600.0, write=60.0, pool=60.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(f"{_base_url()}/api/chat", json=payload)
        resp.raise_for_status()
        return resp.json().get("message", {}).get("content", "")
