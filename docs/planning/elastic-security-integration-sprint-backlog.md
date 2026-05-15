# Elastic Security Integration Sprint Backlog

Status: Draft
Date: 2026-05-15
Owner: Platform + Detection + Frontend
Scope: Event ingestion visibility, detection correlation, Kibana integration, MITRE chain mapping

## 1) Planning Assumptions

- PostgreSQL remains system of record.
- Elasticsearch remains secondary search and analytics store.
- Existing PR1-PR3 foundation is available:
  - optional elastic bootstrap
  - outbox indexer worker
  - event provider routing (auto/postgres/elastic)

## 2) Sprint Goals

Sprint goal is to deliver a demonstrable end-to-end chain:

1. Event arrives from supported source type.
2. Event is indexed and searchable in Elasticsearch/Kibana.
3. Correlation rule fires on realistic sequence.
4. Incident displays MITRE technique mapping.

## 3) Work Packages and Ticket Backlog

## Sprint A - Ingestion Visibility

### A-01 Source Type Contract Extension
- Size: M
- Priority: High
- Description:
  - Extend source type support for filebeat, winlogbeat, elastic_agent, syslog.
  - Keep backward compatibility for existing source types.
- Deliverables:
  - source type enum/schema update
  - API validation updates
  - docs updates
- Acceptance:
  - API can create/list these source types without breaking old clients.

### A-02 ECS Normalization Layer
- Size: L
- Priority: High
- Description:
  - Add normalization from ECS-like fields to internal canonical event shape.
- Deliverables:
  - mapper module (event.code, host.name, user.name, process.command_line, source.ip)
  - unit tests for mappings and fallback behavior
- Acceptance:
  - mixed source payloads normalize into consistent event fields.

### A-03 Ingestion Health Metrics
- Size: M
- Priority: High
- Description:
  - Add per-source visibility metrics for ingestion quality and freshness.
- Deliverables:
  - events_per_min, parse_error_count, last_seen_at
  - backend endpoint and UI indicator block
- Acceptance:
  - source health is visible in UI and API with real-time updates.

### A-04 Demo Data Generator for Source Types
- Size: S
- Priority: Medium
- Description:
  - Provide deterministic sample payload generator for filebeat/winlogbeat/syslog/agent.
- Deliverables:
  - scripts/demo-seed-elastic-sources.sh (or python equivalent)
- Acceptance:
  - one command seeds representative sample events.

## Sprint B - Detection Correlation

### B-01 Correlation Rule Model Extension
- Size: L
- Priority: High
- Description:
  - Add sequence-capable rule model: step-based conditions over time window.
- Deliverables:
  - rule schema extension (sequence, group_by_entity, window_seconds)
  - migration + backward-compatible defaults
- Acceptance:
  - existing simple rules still work; sequence rules are supported.

### B-02 Multiple Failed Logins Correlation Rule
- Size: M
- Priority: High
- Description:
  - Correlate repeated auth failures by user/source_ip over short windows.
- Acceptance:
  - deterministic test data triggers incident reliably.

### B-03 Geo Anomaly Rule
- Size: M
- Priority: High
- Description:
  - Detect unusual country/ASN login compared to baseline for same user.
- Acceptance:
  - baseline + anomaly scenario tested; false positive guard documented.

### B-04 Privilege Escalation Sequence Rule
- Size: M
- Priority: High
- Description:
  - Sequence example: auth success -> privilege-related action -> sensitive command.
- Acceptance:
  - sequence matching works with order and time-bound constraints.

### B-05 Suspicious PowerShell Chain Rule
- Size: M
- Priority: High
- Description:
  - Correlate encoded/hidden powershell indicators plus follow-up suspicious execution.
- Acceptance:
  - command-chain test fixture triggers expected incident.

### B-06 Correlation Confidence Scoring
- Size: M
- Priority: Medium
- Description:
  - Add confidence score from sequence completeness and signal strength.
- Acceptance:
  - incidents include confidence and rationale summary.

## Sprint C - Kibana Integration

### C-01 Kibana Saved Searches and Dashboard Assets
- Size: M
- Priority: High
- Description:
  - Create exportable Kibana saved objects for security demo views.
- Deliverables:
  - discover query set
  - dashboard JSON export
- Acceptance:
  - imported assets run without manual field fixes.

### C-02 Incident-to-Kibana Deep Link
- Size: M
- Priority: High
- Description:
  - Add deep link from incident detail to Kibana Discover with prefilled filters.
- Acceptance:
  - click from incident opens matching event set in Kibana.

### C-03 Screenshot Runbook
- Size: S
- Priority: Medium
- Description:
  - Add deterministic screenshot checklist and capture order.
- Deliverables:
  - docs/operations/kibana-demo-screenshots.md
- Acceptance:
  - anyone can reproduce same 3-5 screenshots.

## Sprint D - MITRE Chain Mapping

### D-01 Rule Metadata MITRE Fields
- Size: M
- Priority: High
- Description:
  - Add mitre_techniques and optional tactic metadata at rule level.
- Deliverables:
  - migration
  - API schema updates
- Acceptance:
  - rule CRUD supports MITRE metadata.

### D-02 Incident MITRE Enrichment
- Size: M
- Priority: High
- Description:
  - Copy or resolve MITRE mapping onto incidents at creation time.
- Acceptance:
  - incident detail always includes resolved MITRE techniques for mapped rules.

### D-03 UI Chain Visualization
- Size: M
- Priority: High
- Description:
  - Show chain block: Event -> Rule -> MITRE in incident and/or event detail.
- Acceptance:
  - visual chain is present and test-covered.

### D-04 MITRE Coverage View
- Size: M
- Priority: Medium
- Description:
  - Add summary endpoint/UI for mapped techniques and rule coverage.
- Acceptance:
  - coverage list and counts are queryable and visible.

## 4) Suggested Sprint Sequence

1. Sprint A first (foundation for visible multi-source ingestion).
2. Sprint B second (security value and incident quality).
3. Sprint D third (explainability and reporting strength).
4. Sprint C can run partly parallel with B/D once dashboards have stable fields.

## 5) Dependencies

- B depends on A-02 (stable normalized fields).
- C depends on A + partial B (useful data and detections present).
- D depends on B-01 (rule model extension in place).

## 6) Definition of Done (Program Level)

Program is done when all conditions are met:

1. At least 4 ingestion source types are demoable end-to-end.
2. At least 4 correlation detections trigger with deterministic fixtures.
3. Kibana dashboard + discover flow works from documented runbook.
4. MITRE chain is visible in incident workflow and API.
5. README and Docker docs reflect the final runtime and demo path.

## 7) Risk Register

- Risk: ECS field variance across sources.
  - Mitigation: strict normalization and fallback mapping tests.
- Risk: False positives in correlation rules.
  - Mitigation: confidence scoring + suppression lists.
- Risk: Elastic pressure at scale.
  - Mitigation: ILM policy, batch tuning, backpressure and retry strategy.
- Risk: Demo drift between environments.
  - Mitigation: seeded fixtures + screenshot runbook.

## 8) Effort Summary (Rough)

- Sprint A: 2-3 weeks
- Sprint B: 2-3 weeks
- Sprint C: 1-2 weeks
- Sprint D: 1-2 weeks

Total program estimate: 6-10 weeks depending on team size and parallelization.
