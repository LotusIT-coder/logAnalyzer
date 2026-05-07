from __future__ import annotations

from functools import lru_cache
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    app_env: str = "development"
    app_version: str = "0.1.0"
    build_commit: str = "local"

    database_url: str
    ollama_base_url: str = "http://127.0.0.1:11434"

    api_token_signing_key: str = "dev-only-no-auth"
    cors_allowed_origins: str = "http://localhost:5173"
    public_base_url: str = "http://localhost:8080"
    disable_auth: bool = True  # set DISABLE_AUTH=false to require token
    watcher_interval_seconds: float = 5.0
    rule_scheduler_interval_seconds: float = 30.0
    notification_webhook_url: str | None = None

    @property
    def cors_origins_list(self) -> List[str]:
        return [o.strip() for o in self.cors_allowed_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
