# Network SQL Schema And Migration Plan

Status: Draft
Datum: 2026-05-07
Abhaengigkeiten: db/schema.sql, network-observability-architecture.md

## 1) Ziel

Dieses Dokument beschreibt das Zielschema und eine migrationssichere Reihenfolge, um Netzwerktelemetrie einzufuehren, ohne das bestehende Event- und Incident-Modell zu destabilisieren.

## 2) Leitprinzipien

1. Netzwerktelemetrie bekommt eigene Tabellen.
2. Roh- oder Nahe-Rohdaten bleiben append-only.
3. Zeit- und Quellenfilter muessen frueh indizierbar sein.
4. Payload-Dateien gehoeren nicht in PostgreSQL.
5. Grosse Tabellen werden von Anfang an auf Partitionierung vorbereitet.

## 3) Source-Tabelle erweitern

Bestehende `source.type`-Werte:

- `file`
- `syslog`
- `journald`
- `docker`

Empfohlene Erweiterung:

- `netflow`
- `sflow`
- `socket_observer`
- `packet_capture`

Migrationsregel:

- Der erste Schritt erweitert nur den Check-Constraint und die Source-Konfiguration.

## 4) Neue Tabellen

### 4.1 network_flow

Primärmodell fuer NetFlow/IPFIX, sFlow-Flow-Samples und spaeter hostbasierte Verbindungsaggregation.

Empfohlene Felder:

- `id UUID PRIMARY KEY`
- `source_id UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE`
- `collector_node_id TEXT`
- `telemetry_type TEXT NOT NULL CHECK (telemetry_type IN ('netflow','ipfix','sflow','socket_observer'))`
- `observed_at_start TIMESTAMPTZ NOT NULL`
- `observed_at_end TIMESTAMPTZ NOT NULL`
- `host_id TEXT`
- `exporter_addr INET`
- `observation_domain_id BIGINT`
- `src_ip INET NOT NULL`
- `dst_ip INET NOT NULL`
- `src_port INTEGER`
- `dst_port INTEGER`
- `protocol TEXT NOT NULL`
- `bytes BIGINT NOT NULL DEFAULT 0`
- `packets BIGINT NOT NULL DEFAULT 0`
- `connections INTEGER NOT NULL DEFAULT 1`
- `direction TEXT`
- `action TEXT`
- `app_hint TEXT`
- `process_name TEXT`
- `container_id TEXT`
- `sample_factor NUMERIC(12,4) NOT NULL DEFAULT 1.0`
- `confidence NUMERIC(5,4) NOT NULL DEFAULT 1.0`
- `tcp_flags TEXT`
- `ingress_if TEXT`
- `egress_if TEXT`
- `raw_ref TEXT`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Indizes:

- `idx_network_flow_observed_at_end` auf `observed_at_end DESC`
- `idx_network_flow_source_id_time` auf `(source_id, observed_at_end DESC)`
- `idx_network_flow_src_ip_time` auf `(src_ip, observed_at_end DESC)`
- `idx_network_flow_dst_ip_time` auf `(dst_ip, observed_at_end DESC)`
- `idx_network_flow_protocol_port` auf `(protocol, dst_port)`
- `idx_network_flow_host_process` auf `(host_id, process_name)`

Optional spaeter:

- BRIN auf `observed_at_end`
- deklarative Partitionierung nach `observed_at_end`

### 4.2 interface_sample

Zeitreihe pro Host und Interface.

Empfohlene Felder:

- `id UUID PRIMARY KEY`
- `source_id UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE`
- `host_id TEXT NOT NULL`
- `interface_name TEXT NOT NULL`
- `ts TIMESTAMPTZ NOT NULL`
- `rx_bytes BIGINT NOT NULL DEFAULT 0`
- `tx_bytes BIGINT NOT NULL DEFAULT 0`
- `rx_packets BIGINT NOT NULL DEFAULT 0`
- `tx_packets BIGINT NOT NULL DEFAULT 0`
- `rx_drops BIGINT NOT NULL DEFAULT 0`
- `tx_drops BIGINT NOT NULL DEFAULT 0`
- `rx_errors BIGINT NOT NULL DEFAULT 0`
- `tx_errors BIGINT NOT NULL DEFAULT 0`
- `speed_bps BIGINT`
- `oper_state TEXT`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Indizes:

- `(host_id, interface_name, ts DESC)`
- `(source_id, ts DESC)`

### 4.3 socket_sample

Host- und Prozesssicht auf Verbindungen.

Empfohlene Felder:

- `id UUID PRIMARY KEY`
- `source_id UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE`
- `host_id TEXT NOT NULL`
- `ts TIMESTAMPTZ NOT NULL`
- `pid INTEGER`
- `process_name TEXT`
- `executable TEXT`
- `user_name TEXT`
- `container_id TEXT`
- `local_ip INET NOT NULL`
- `local_port INTEGER`
- `remote_ip INET NOT NULL`
- `remote_port INTEGER`
- `protocol TEXT NOT NULL`
- `state TEXT NOT NULL`
- `bytes_in BIGINT`
- `bytes_out BIGINT`
- `lifetime_ms BIGINT`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Indizes:

- `(host_id, ts DESC)`
- `(process_name, ts DESC)`
- `(remote_ip, ts DESC)`
- `(protocol, state)`

### 4.4 network_exporter_state

Leichtgewichtige Zustandstabelle fuer Exporter, Templates und Decoder-Qualitaet.

Empfohlene Felder:

- `id UUID PRIMARY KEY`
- `source_id UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE`
- `collector_node_id TEXT NOT NULL`
- `telemetry_type TEXT NOT NULL CHECK (telemetry_type IN ('netflow','ipfix','sflow'))`
- `exporter_addr INET NOT NULL`
- `observation_domain_id BIGINT`
- `last_seen_at TIMESTAMPTZ NOT NULL`
- `status TEXT NOT NULL`
- `template_ok BOOLEAN NOT NULL DEFAULT TRUE`
- `sequence_gap_count BIGINT NOT NULL DEFAULT 0`
- `decode_error_count BIGINT NOT NULL DEFAULT 0`
- `sample_factor NUMERIC(12,4)`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Constraints:

- eindeutiger Schluessel ueber `(collector_node_id, telemetry_type, exporter_addr, observation_domain_id)`

### 4.5 capture_job

Verwaltung von Packet-Capture-Sessions.

Empfohlene Felder:

- `id UUID PRIMARY KEY`
- `source_id UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE`
- `requested_by TEXT NOT NULL`
- `target_host TEXT NOT NULL`
- `interface_name TEXT NOT NULL`
- `bpf_filter TEXT NOT NULL`
- `snaplen INTEGER NOT NULL`
- `duration_seconds INTEGER NOT NULL`
- `retention_until TIMESTAMPTZ NOT NULL`
- `status TEXT NOT NULL CHECK (status IN ('pending','running','stopping','completed','failed','expired'))`
- `reason TEXT NOT NULL`
- `started_at TIMESTAMPTZ`
- `ended_at TIMESTAMPTZ`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

### 4.6 capture_artifact

Metadaten fuer PCAP- oder PCAPNG-Artefakte.

Empfohlene Felder:

- `id UUID PRIMARY KEY`
- `job_id UUID NOT NULL REFERENCES capture_job(id) ON DELETE CASCADE`
- `storage_backend TEXT NOT NULL`
- `object_path TEXT NOT NULL`
- `sha256 TEXT NOT NULL`
- `packet_count BIGINT NOT NULL DEFAULT 0`
- `byte_size BIGINT NOT NULL DEFAULT 0`
- `encrypted BOOLEAN NOT NULL DEFAULT TRUE`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

## 5) Nicht empfohlene Tabellenentscheidungen

Diese Dinge sollten explizit vermieden werden:

- keine generische `network_event`-Tabelle fuer alles
- keine Payload- oder Hex-Dumps in `event.fields_json`
- keine PCAP-BLOBs in PostgreSQL
- keine Quelltypen, die gleichzeitig Collector und Capture semantisch mischen

## 6) Beziehung zum bestehenden Event-Modell

`event` bleibt bestehen fuer:

- Parser-Ergebnisse
- Korrelation und Rules
- abgeleitete Anomalien
- nutzerorientierte Investigation

Empfehlung:

- Falls aus Netzwerktelemetrie ein Incident-relevantes Signal entsteht, wird daraus optional ein abgeleitetes Event erzeugt.
- Der gesamte Rohfluss landet nicht in `event`.

## 7) Retention-Strategie

Empfohlene Defaults:

- `network_flow`: 14 bis 30 Tage Rohdaten, danach nur Aggregation
- `interface_sample`: 30 bis 90 Tage, je nach Bucket und Volumen
- `socket_sample`: 7 bis 14 Tage
- `capture_job`: 30 bis 90 Tage Metadaten
- `capture_artifact`: sehr kurz, typischerweise 24 bis 72 Stunden

Wichtige Regel:

- Retention-Policies muessen pro Tabelle separat steuerbar sein.

## 8) Partitionierung und Materialisierung

Absehbar grosse Tabellen:

- `network_flow`
- `interface_sample`
- `socket_sample`

Empfehlung:

1. erste Migrationen noch ohne volle Partitionierung, aber mit kompatiblen Zeitspalten und Indizes
2. vor Produktivvolumen `network_flow` nach Zeit partitionieren
3. fuer UI-intensive Aggregationen spaeter materialisierte Views einziehen

Beispiel fuer spaetere Materialized Views:

- `network_flow_hourly_agg`
- `interface_sample_5m_agg`
- `top_talkers_daily_agg`

## 9) Alembic-Migrationsplan

Empfohlene Reihenfolge:

### 0005_extend_source_types_for_network

Zweck:

- Check-Constraint fuer `source.type` erweitern

Nur dieser Schritt, keine neuen Tabellen.

### 0006_add_network_flow_tables

Zweck:

- `network_flow`
- `network_exporter_state`

### 0007_add_interface_and_socket_samples

Zweck:

- `interface_sample`
- `socket_sample`

### 0008_add_capture_job_tables

Zweck:

- `capture_job`
- `capture_artifact`

### 0009_add_network_views_and_indexes

Zweck:

- spaetere Materialized Views oder zusaetzliche BRIN-Indizes

Wichtige Regel:

- Komplexe Materialized Views nicht in die ersten Funktionsmigrationen pressen.

## 10) Rollout-Strategie ohne Downtime-Fallen

Empfohlene Reihenfolge im Betrieb:

1. Tabellen und neue Source-Typen deployen
2. Collector kann bereits schreiben, auch wenn UI noch nicht liest
3. neue Read-APIs gegen neue Tabellen schalten
4. erst danach bestehende `/metrics/network/map`-Implementierung umverdrahten

Das reduziert das Risiko, gleichzeitig Ingest, API und UI brechen zu lassen.

## 11) Testplan fuer die Datenbankebene

Pflichttests pro Migration:

- Upgrade und Downgrade laufen sauber
- Fremdschluessel funktionieren wie erwartet
- Zeit- und Quellenfilter nutzen Indizes vernuenftig
- Capture-Artefakte werden mit Job-Loeschung sauber entfernt
- Source-Typ-Checks erlauben nur die vorgesehenen Werte

## 12) Empfehlung fuer die praktische Umsetzung

Die erste echte Implementierung sollte nur bis `network_flow` gehen. `interface_sample`, `socket_sample` und `capture_*` koennen im selben Plan stehen, aber in spaeteren Migrationsslices folgen. So bleibt Phase A klein genug und die bestehende Netzwerkseite kann frueh auf ein belastbares Flow-Modell migriert werden.