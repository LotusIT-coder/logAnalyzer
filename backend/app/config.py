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

    # Realtime heuristics (pre-AI signal detection)
    heuristics_enabled: bool = True
    heuristics_current_window_minutes: int = 2
    heuristics_baseline_window_minutes: int = 10
    heuristics_baseline_windows: int = 6
    heuristics_min_burst_count: int = 8
    heuristics_burst_ratio_threshold: float = 3.0
    heuristics_min_novelty_count: int = 5
    heuristics_cooldown_minutes: int = 15

    # SOC Analyst – continuous AI-driven threat monitoring
    soc_analyst_enabled: bool = True
    soc_analyst_model: str = "llama3"
    soc_analyst_interval_seconds: float = 20.0
    soc_analyst_confidence_threshold: float = 0.3
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

    # Internal event bus (used as pre-broker transport)
    event_bus_workers: int = 2
    event_bus_queue_size: int = 5000
    event_bus_max_retry_attempts: int = 3
    event_bus_retry_backoff_seconds: float = 0.2
    event_bus_dead_letter_max: int = 1000
    event_bus_drain_timeout_seconds: float = 5.0

    @property
    def cors_origins_list(self) -> List[str]:
        return [o.strip() for o in self.cors_allowed_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
