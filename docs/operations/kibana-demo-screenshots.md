# Kibana Demo Screenshot Runbook

This runbook provides a deterministic capture order for Sprint C-03.
Kibana remains optional. Use this only when Kibana is available.

## Prerequisites

1. Backend is running and ingest seeded demo data.
2. Elasticsearch is reachable.
3. Kibana Saved Objects imported from:
   - `docs/kibana/loganalyzer-security-demo.ndjson`

## Fixed capture settings

1. Time range in Kibana: `Last 24 hours`
2. Browser zoom: `100%`
3. Kibana theme: `Dark` (or `Light`, but keep consistent for all screenshots)
4. Sort order where applicable: `timestamp desc`
5. Screenshot format: PNG
6. Resolution target: 1920x1080

## Capture order (exact)

1. Discover - Auth Failures
   - Open saved search: `LogAnalyzer - Auth Failures`
   - Verify at least one failed-auth style event row is visible
   - Save as: `docs/screenshots/kibana-01-discover-auth-failures.png`

2. Discover - Suspicious PowerShell
   - Open saved search: `LogAnalyzer - Suspicious PowerShell`
   - Verify encoded/hidden PowerShell indicator in table rows
   - Save as: `docs/screenshots/kibana-02-discover-powershell.png`

3. Dashboard - Security Demo
   - Open dashboard: `LogAnalyzer - Security Demo Dashboard`
   - Confirm all four panels are rendered
   - Save as: `docs/screenshots/kibana-03-dashboard-overview.png`

4. Dashboard Drilldown
   - From dashboard, open panel menu on `Auth Failures`
   - Use `Explore data in Discover` (or equivalent drilldown action)
   - Save as: `docs/screenshots/kibana-04-drilldown-discover.png`

5. MITRE-focused query snapshot (optional but recommended)
   - In Discover, query for one mapped technique (example): `mitre.technique : "T1110"`
   - Save as: `docs/screenshots/kibana-05-mitre-query.png`

## Quality checklist

1. Timestamp column visible in all Discover screenshots.
2. Query bar visible in all Discover screenshots.
3. Panel titles visible in dashboard screenshots.
4. No sensitive hostnames/IPs unless intentionally part of demo data.
5. File names match the exact naming scheme above.

## Troubleshooting

1. If panels show no data, re-run seed flow and refresh Kibana data view.
2. If fields are missing, re-import saved objects and verify index pattern `logs-events-v1-*`.
3. If drilldown does not appear, open panel in Discover manually and continue with the same capture naming.
