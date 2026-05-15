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

    # Logging
    log_dir: str = "logs"

    # Ollama availability
    ollama_path: str = "/usr/bin/ollama"

    cors_allowed_origins: str = "http://localhost:5173"
    # Idle poll interval for the file/journald watcher. When the previous tick
    # produced data the loop runs again immediately (catch-up mode); this value
    # only takes effect when there is nothing new to ingest. Override via env
    # `WATCHER_INTERVAL_SECONDS`.
    watcher_interval_seconds: float = 0.5
    # Minimum sleep between ticks even in catch-up mode, to keep DB load bounded.
    watcher_catchup_min_sleep_seconds: float = 0.02
    rule_scheduler_interval_seconds: float = 30.0
    notification_webhook_url: str | None = None

    # SOC Analyst – continuous AI-driven threat monitoring
    soc_analyst_enabled: bool = False
    soc_analyst_model: str = "llama3"
    soc_analyst_interval_seconds: float = 60.0
    soc_analyst_confidence_threshold: float = 0.7
    soc_analyst_window_events: int = 100

    # Elasticsearch (optional secondary search/analytics store)
    elastic_enabled: bool = False
    elastic_url: str = "http://127.0.0.1:9200"
    elastic_username: str | None = None
    elastic_password: str | None = None
    elastic_verify_tls: bool = True
    elastic_timeout_seconds: float = 3.0
    elastic_ilm_policy_name: str = "loganalyzer-events-policy-v1"
    elastic_index_template_name: str = "loganalyzer-events-template-v1"
    elastic_index_pattern: str = "logs-events-v1-*"
    elastic_index_name: str = "logs-events-v1-default"
    elastic_indexer_enabled: bool = False
    elastic_indexer_interval_seconds: float = 5.0
    elastic_indexer_batch_size: int = 500
    elastic_indexer_max_retries: int = 8

    @property
    def cors_origins_list(self) -> List[str]:
        return [o.strip() for o in self.cors_allowed_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
