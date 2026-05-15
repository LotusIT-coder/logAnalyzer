# Kibana Saved Objects (Optional)

This project ships optional Kibana assets for Sprint C-01.
Kibana is not required for runtime. If Kibana is present, you can import these objects.

## Asset file

- `docs/kibana/loganalyzer-security-demo.ndjson`

Included objects:

- Index pattern: `logs-events-v1-*` (time field `timestamp`)
- Discover saved searches:
  - `LogAnalyzer - Auth Failures`
  - `LogAnalyzer - Suspicious PowerShell`
  - `LogAnalyzer - Geo Anomalies`
- Visualizations:
  - `LogAnalyzer - Events Over Time`
  - `LogAnalyzer - Top Services`
- Dashboard:
  - `LogAnalyzer - Security Demo Dashboard`

## Import steps

1. Ensure events are indexed in Elasticsearch.
2. Open Kibana: `Stack Management -> Saved Objects`.
3. Click `Import` and select `docs/kibana/loganalyzer-security-demo.ndjson`.
4. If prompted for missing references, map to index pattern `logs-events-v1-*`.

## Quick verify checklist

1. Open Discover and load `LogAnalyzer - Auth Failures`.
2. Open dashboard `LogAnalyzer - Security Demo Dashboard`.
3. Confirm visualizations render and time filter affects all panels.

For deterministic demo screenshots, follow:

- `docs/operations/kibana-demo-screenshots.md`

## Notes

- If your index naming differs, adjust the index pattern object title and re-import.
- The queries use KQL and are intentionally conservative for seeded demo data.
