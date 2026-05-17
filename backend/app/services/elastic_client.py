"""Minimal Elasticsearch client helpers for startup health and bootstrap."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import httpx
import structlog


logger = structlog.get_logger(__name__)


@dataclass(slots=True)
class ElasticClient:
    base_url: str
    verify_tls: bool
    timeout_seconds: float
    username: str | None = None
    password: str | None = None

    @classmethod
    def from_settings(cls, settings) -> "ElasticClient":
        return cls(
            base_url=settings.elastic_url,
            verify_tls=settings.elastic_verify_tls,
            timeout_seconds=settings.elastic_timeout_seconds,
            username=settings.elastic_username,
            password=settings.elastic_password,
        )

    def _auth(self) -> tuple[str, str] | None:
        if self.username and self.password:
            return (self.username, self.password)
        return None

    async def ping(self) -> bool:
        try:
            async with httpx.AsyncClient(
                base_url=self.base_url,
                verify=self.verify_tls,
                timeout=self.timeout_seconds,
                auth=self._auth(),
            ) as client:
                response = await client.get("/")
                response.raise_for_status()
                return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("elastic_ping_failed", error=str(exc), base_url=self.base_url)
            return False

    async def ensure_bootstrap(
        self,
        *,
        ilm_policy_name: str,
        index_template_name: str,
        index_pattern: str,
    ) -> bool:
        ilm_policy: dict[str, Any] = {
            "policy": {
                "phases": {
                    "hot": {
                        "actions": {
                            "set_priority": {"priority": 100}
                        }
                    },
                    "delete": {
                        "min_age": "30d",
                        "actions": {"delete": {}},
                    },
                }
            }
        }

        index_template: dict[str, Any] = {
            "index_patterns": [index_pattern],
            "template": {
                "settings": {
                    "index.lifecycle.name": ilm_policy_name,
                },
                "mappings": {
                    "properties": {
                        "event_id": {"type": "keyword"},
                        "timestamp": {"type": "date"},
                        "created_at": {"type": "date"},
                        "severity": {"type": "keyword"},
                        "service": {"type": "keyword"},
                        "host": {"type": "keyword"},
                        "environment": {"type": "keyword"},
                        "event_type": {"type": "keyword"},
                        "message": {
                            "type": "text",
                            "fields": {"raw": {"type": "keyword", "ignore_above": 1024}},
                        },
                        "source_id": {"type": "keyword"},
                        "fingerprint": {"type": "keyword"},
                        "fields_json": {"type": "object", "enabled": True},
                    }
                },
            },
            "priority": 100,
            "version": 1,
        }

        try:
            async with httpx.AsyncClient(
                base_url=self.base_url,
                verify=self.verify_tls,
                timeout=self.timeout_seconds,
                auth=self._auth(),
            ) as client:
                ilm_response = await client.put(
                    f"/_ilm/policy/{ilm_policy_name}",
                    json=ilm_policy,
                )
                ilm_response.raise_for_status()

                tpl_response = await client.put(
                    f"/_index_template/{index_template_name}",
                    json=index_template,
                )
                tpl_response.raise_for_status()

            logger.info(
                "elastic_bootstrap_ok",
                ilm_policy_name=ilm_policy_name,
                index_template_name=index_template_name,
                index_pattern=index_pattern,
            )
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "elastic_bootstrap_failed",
                error=str(exc),
                ilm_policy_name=ilm_policy_name,
                index_template_name=index_template_name,
                index_pattern=index_pattern,
            )
            return False

    async def bulk_index_events(self, *, index_name: str, docs: list[dict[str, Any]]) -> tuple[int, int]:
        """Index documents via Elasticsearch _bulk API.

        Returns (success_count, error_count).
        """
        if not docs:
            return (0, 0)

        lines: list[str] = []
        for doc in docs:
            event_id = str(doc.get("event_id"))
            lines.append(
                f'{{"index":{{"_index":"{index_name}","_id":"{event_id}"}}}}'
            )
            lines.append(json.dumps(doc, default=str))
        payload = "\n".join(lines) + "\n"

        try:
            async with httpx.AsyncClient(
                base_url=self.base_url,
                verify=self.verify_tls,
                timeout=max(self.timeout_seconds, 10.0),
                auth=self._auth(),
            ) as client:
                response = await client.post(
                    "/_bulk",
                    content=payload,
                    headers={"Content-Type": "application/x-ndjson"},
                )
                response.raise_for_status()
                body = response.json()

            items = body.get("items", [])
            error_count = sum(1 for item in items if item.get("index", {}).get("error"))
            success_count = max(0, len(items) - error_count)
            if error_count:
                logger.warning("elastic_bulk_partial_failure", success=success_count, errors=error_count)
            return (success_count, error_count)
        except Exception as exc:  # noqa: BLE001
            logger.warning("elastic_bulk_failed", error=str(exc), index_name=index_name)
            return (0, len(docs))

    async def search_events(
        self,
        *,
        index_pattern: str,
        from_ts: datetime | None,
        to_ts: datetime | None,
        source_ids: list[str] | None,
        severity_values: list[str] | None,
        service: str | None,
        host: str | None,
        q: str | None,
        limit: int,
        cursor: datetime | None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        filters: list[dict[str, Any]] = []
        if from_ts or to_ts or cursor:
            time_should: list[dict[str, Any]] = []

            if from_ts or to_ts:
                timestamp_range: dict[str, Any] = {}
                created_range: dict[str, Any] = {}
                if from_ts:
                    timestamp_range["gte"] = from_ts.isoformat()
                    created_range["gte"] = from_ts.isoformat()
                if to_ts:
                    timestamp_range["lte"] = to_ts.isoformat()
                    created_range["lte"] = to_ts.isoformat()
                time_should.extend([
                    {"range": {"timestamp": timestamp_range}},
                    {"range": {"created_at": created_range}},
                ])

            if time_should:
                filters.append({
                    "bool": {
                        "should": time_should,
                        "minimum_should_match": 1,
                    }
                })

            if cursor:
                filters.append({"range": {"created_at": {"lt": cursor.isoformat()}}})

        if source_ids is not None:
            filters.append({"terms": {"source_id": source_ids}})
        if severity_values:
            filters.append({"terms": {"severity": severity_values}})

        must: list[dict[str, Any]] = []
        if service:
            must.append({"wildcard": {"service": {"value": f"*{service.lower()}*", "case_insensitive": True}}})
        if host:
            must.append({"wildcard": {"host": {"value": f"*{host.lower()}*", "case_insensitive": True}}})
        if q:
            must.append({"match_phrase": {"message": q}})

        body: dict[str, Any] = {
            "size": limit + 1,
            "sort": [{"created_at": "desc"}, {"event_id": "desc"}],
            "query": {
                "bool": {
                    "filter": filters,
                    "must": must,
                }
            },
        }

        try:
            async with httpx.AsyncClient(
                base_url=self.base_url,
                verify=self.verify_tls,
                timeout=max(self.timeout_seconds, 10.0),
                auth=self._auth(),
            ) as client:
                response = await client.post(f"/{index_pattern}/_search", json=body)
                response.raise_for_status()
                payload = response.json()

            hits = payload.get("hits", {}).get("hits", [])
            rows = [hit.get("_source", {}) for hit in hits]
            next_cursor: str | None = None
            if len(rows) > limit:
                rows = rows[:limit]
                next_cursor = rows[-1].get("created_at") or rows[-1].get("timestamp")
            return rows, next_cursor
        except Exception as exc:  # noqa: BLE001
            logger.warning("elastic_search_failed", error=str(exc), index_pattern=index_pattern)
            raise
