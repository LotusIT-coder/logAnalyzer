from __future__ import annotations

from app.ai.ollama_client import list_models


def _candidate_names(model_name: str) -> set[str]:
    model = (model_name or '').strip()
    if not model:
        return set()
    if ':' in model:
        base = model.split(':', 1)[0]
        return {model, f'{base}:latest', base}
    return {model, f'{model}:latest'}


async def is_ollama_model_available(model_name: str) -> tuple[bool, list[str]]:
    models = await list_models()
    installed = [str(item.get('name', '')).strip() for item in models if isinstance(item, dict)]
    installed_set = {name for name in installed if name}

    for candidate in _candidate_names(model_name):
        if candidate in installed_set:
            return True, installed

    # Also accept installed variants like "llama3:8b" when config says "llama3".
    model_base = (model_name or '').split(':', 1)[0].strip()
    if model_base and any(name.startswith(f'{model_base}:') for name in installed_set):
        return True, installed

    return False, installed
