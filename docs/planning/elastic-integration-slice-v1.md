# Elastic Integration Slice v1

Status: Proposal
Date: 2026-05-15
Dependencies: mvp-scope-freeze.md, technical-guardrails.md, spec/openapi.v1.yaml

## Goal

Integrate Elasticsearch as a secondary search and analytics store, while PostgreSQL remains the system of record for events, incidents, rules, and workflows.

## Non-Goals (v1)

- No replacement of PostgreSQL with Elasticsearch
- No hard dependency on Kibana
- No breaking change for existing API consumers
- No mandatory queue infrastructure in first production cut

## Architecture Decision

1. Primary write path stays PostgreSQL.
2. Elastic is used for high-volume event search and aggregations.
3. Read path can route by capability:
   - structured transactional views -> PostgreSQL
   - full-text and large time-range search -> Elasticsearch
4. Feature flag controls Elastic usage and allows fast fallback.

## Data Model (Elastic event document)

Required fields:
- event_id (keyword)
- timestamp (date)
- severity (keyword)
- service (keyword)
- host (keyword)
- environment (keyword)
- event_type (keyword)
- message (text + keyword subfield)
- source_id (keyword)
- fingerprint (keyword)
- fields_json (flattened/object)

Indexing strategy:
- data stream or rollover index family: logs-events-v1
- ILM policy with hot retention baseline (example: 14-30 days)
- deterministic document id = event_id to make re-index idempotent

## Delivery Plan in 3 PRs

### PR 1: Foundation (Config, Client, Mapping, Docker)

Scope:
1. Add backend config for Elastic endpoint/auth/feature flag.
2. Add Elastic client module with health check and index bootstrap.
3. Add index template and ILM bootstrap helpers.
4. Extend docker-compose with optional elastic service profile.
5. Add operations notes for startup and health validation.

Likely file touch set:
- backend/app/config.py
- backend/app/main.py
- backend/app/services/elastic_client.py (new)
- deploy/docker or root docker-compose.yml
- docs/operations/local-runtime.md
- README.md

Acceptance criteria:
1. Backend starts with Elastic disabled and unchanged behavior.
2. Backend starts with Elastic enabled when endpoint is reachable.
3. Health endpoint exposes Elastic availability status.
4. Compose can start optional Elastic service cleanly.

Rollback:
- Disable feature flag and restart backend.

### PR 2: Reliable Sync Pipeline (Outbox + Worker + Backfill)

Scope:
1. Add outbox table for event index jobs.
2. Write outbox records on event creation.
3. Add async worker to flush outbox batches to Elastic.
4. Add retry/backoff and dead-letter marker for failures.
5. Add one-shot backfill command for historical events.

Likely file touch set:
- backend/alembic/versions/xxxx_event_index_outbox.py (new)
- backend/app/domain/models.py
- backend/app/ingestion/* (write outbox records)
- backend/app/services/elastic_indexer.py (new)
- backend/app/main.py (worker lifecycle)
- scripts/* (optional backfill helper)
- docs/operations/local-runtime.md

Acceptance criteria:
1. New events appear in Elastic with deterministic event_id document id.
2. Temporary Elastic outage does not lose events (retry path works).
3. Backfill can index existing PostgreSQL events in batches.
4. Worker metrics/logging show processed, failed, retried counts.

Rollback:
- Stop worker and keep application running on PostgreSQL only.

### PR 3: Query Routing and API Surface

Scope:
1. Add search service abstraction with postgres and elastic providers.
2. Route full-text and aggregate-heavy event queries to Elastic behind feature flag.
3. Keep response schema stable for frontend compatibility.
4. Add API query parameter to force provider for diagnostics (optional).
5. Add benchmark and compare latency against current PostgreSQL path.

Likely file touch set:
- backend/app/api/v1/events.py
- backend/app/services/event_search.py (new)
- backend/app/schemas/* (only if needed)
- frontend/src/lib/* (only if API shape changes, avoid if possible)
- tests (API and integration)
- spec/openapi.v1.yaml (if endpoint semantics change)
- README.md

Acceptance criteria:
1. Existing event list UI still works without frontend rewrite.
2. Search latency improves on large datasets for text queries.
3. Feature flag off returns to current PostgreSQL behavior.
4. Tests cover provider routing and fallback.

Rollback:
- Turn off feature flag and restart backend.

## Security and Operations Baseline

1. Do not expose Elastic directly to public networks.
2. Enable auth and transport security in non-local deployments.
3. Mask sensitive fields before indexing if required by policy.
4. Track index size and shard count to avoid cluster pressure.

## Validation Checklist

1. Compose health:
   - backend health ok
   - elastic health green/yellow accepted for single node local
2. Write-path test:
   - ingest sample logs
   - confirm outbox growth then drain
   - confirm documents visible in index
3. Read-path test:
   - event search via API returns expected subset
   - fallback works when Elastic is disabled/unreachable
4. Documentation parity:
   - README updated
   - operations doc updated
   - env vars documented

## Suggested Milestone Order

1. Ship PR 1 with Elastic disabled by default.
2. Ship PR 2 and run in shadow mode (indexing on, reads still PostgreSQL).
3. Ship PR 3 and enable Elastic reads incrementally by environment.
