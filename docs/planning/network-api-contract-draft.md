# Network API Contract Draft

Status: Draft
Datum: 2026-05-07
Abhaengigkeiten: network-observability-architecture.md, spec/openapi.v1.yaml

## 1) Ziel

Dieses Dokument zieht die neue Netzwerk-Domaene in einen konkreten API-Contract-Entwurf herunter, ohne den bestehenden Live-Contract voreilig aufzubrechen.

Ziel ist ein spaeter sauber implementierbarer Satz von REST-Endpunkten fuer:

- Netzwerk-Flows
- Topologie und Aggregationen
- Interface-Timeseries
- Host-Socket-Sicht
- Exporter- und Collector-Gesundheit
- selektive Packet-Capture-Jobs

## 2) Contract-Prinzipien

Die folgenden Regeln sollten verbindlich sein:

1. Netzwerk-Endpunkte leben unter `/api/v1/network/*` und nicht unter `/metrics/*`, ausser fuer bestehende Kompatibilitaetsrouten.
2. Listenendpunkte liefern paginierte Roh- oder Nahe-Rohdaten.
3. Topologie-, Summary- und Timeseries-Endpunkte liefern Aggregationen.
4. Capture-Artefakte selbst werden nicht inline ueber JSON uebertragen, sondern nur per Metadaten und Download-Referenz.
5. Jede Antwort enthaelt nur normalisierte Netzwerkfelder, keine quellspezifischen NetFlow- oder sFlow-Rohstrukturen.

## 3) Rollen und Scopes

Empfohlene Scope-Trennung:

- `read`: lesen von Flows, Topologie, Interfaces, Sockets und Exportern
- `write`: administrative Quellenpflege, Collector-Konfiguration, manuelle Rebuild- oder Reindex-Aktionen
- `admin`: Capture-Jobs, Artefaktzugriff, Telemetrie-Retention, Collector-Health-Administration

Empfehlung:

- Flow- und Interface-Sicht mit `read`
- Capture-Job-Start, Stop, Artefaktliste und Download nur mit `admin`

## 4) Bestehende Routen und Migrationspfad

Heute existiert bereits:

- `/api/v1/metrics/network/map`

Migrationsregel:

1. Diese Route bleibt zunaechst erhalten.
2. Intern kann sie spaeter auf `network_flow` statt auf `event.fields_json` zeigen.
3. Neue UI- und API-Arbeit laeuft auf `/api/v1/network/*`.
4. Eine spaetere Deprecation von `/metrics/network/map` wird separat versioniert und dokumentiert.

## 5) Ressourcenmodell

Die API sollte um folgende Ressourcenfamilien erweitert werden:

- `network/flows`
- `network/flows/map`
- `network/flows/summary`
- `network/interfaces`
- `network/interfaces/timeseries`
- `network/sockets`
- `network/exporters`
- `network/capture/jobs`
- `network/capture/artifacts`

## 6) Gemeinsame Query-Parameter

Fuer moeglichst einheitliche Clients sollten diese Query-Parameter ueber fast alle Netzwerk-Endpunkte hinweg gelten:

- `from`, `to`
- `limit`, `cursor`
- `source_id`, `source_ids`, `source_paths`
- `host_id`
- `exporter_addr`
- `src_ip`, `dst_ip`
- `src_port`, `dst_port`
- `protocol`
- `app_hint`
- `process_name`
- `direction`
- `action`
- `telemetry_type`

Wichtige Normalisierung:

- CSV-Filter wie bei Events koennen fuer `source_ids` und `source_paths` wiederverwendet werden.

## 7) Endpoint-Entwurf

### 7.1 GET /api/v1/network/flows

Zweck:

- paginierte Roh- oder Nahe-Rohliste fuer Netzwerk-Flows

Wichtige Parameter:

- `from`, `to`
- `limit`, `cursor`
- `source_ids`, `source_paths`
- `src_ip`, `dst_ip`
- `protocol`, `dst_port`
- `app_hint`, `process_name`
- `direction`, `action`
- `telemetry_type`

Antwort:

- `items[]`
- `next_cursor`

Beispielshape:

```yaml
NetworkFlowListResponse:
  type: object
  properties:
    items:
      type: array
      items:
        $ref: '#/components/schemas/NetworkFlow'
    next_cursor:
      type: string
      nullable: true
  required: [items]
```

### 7.2 GET /api/v1/network/flows/{id}

Zweck:

- Detailansicht eines Flows fuer Drilldown, Incident-Korrelation und spaetere Capture-Trigger

Antwort sollte enthalten:

- Kern-Flowdaten
- optionale Exporter-Metadaten
- optionale Prozess- und Host-Hinweise
- optionale `capture_available`-Info

### 7.3 GET /api/v1/network/flows/summary

Zweck:

- KPI-Karte fuer Netzwerk-Dashboard und obere UI-Leiste

Empfohlene Felder:

- `total_flows`
- `total_bytes`
- `total_packets`
- `total_connections`
- `unique_sources`
- `unique_destinations`
- `blocked_flows`
- `sampled_flows`
- `new_destination_count`

### 7.4 GET /api/v1/network/flows/map

Zweck:

- Aggregation fuer Topologie-Ansicht

Filter:

- gleiche Grundfilter wie `flows`
- zusaetzlich `group_by` mit erlaubten Werten wie `host`, `process`, `app`, `ip`

Empfohlene Antwort:

```yaml
NetworkMapResponse:
  type: object
  properties:
    nodes:
      type: array
      items:
        $ref: '#/components/schemas/NetworkMapNode'
    edges:
      type: array
      items:
        $ref: '#/components/schemas/NetworkMapEdge'
  required: [nodes, edges]
```

### 7.5 GET /api/v1/network/interfaces

Zweck:

- aktuelle oder letzte bekannte Interface-Werte pro Host und Interface

Filter:

- `host_id`
- `interface_name`
- `source_ids`

Empfohlene Antwort:

- `items[]` mit je einem aktuellen Stand pro Interface

### 7.6 GET /api/v1/network/interfaces/timeseries

Zweck:

- Zeitreihe fuer RX/TX, Drops und Errors

Parameter:

- `from`, `to`, `bucket`
- `host_id`
- `interface_name`

Empfohlene Antwort:

- `points[]` mit `ts`, `rx_bytes`, `tx_bytes`, `rx_drops`, `tx_drops`, `rx_errors`, `tx_errors`

### 7.7 GET /api/v1/network/sockets

Zweck:

- Host-zentrierte Sicht auf Prozesse, Sockets und Ziele

Filter:

- `host_id`
- `pid`
- `process_name`
- `container_id`
- `local_ip`, `remote_ip`
- `protocol`, `state`

Wichtige Regel:

- Nur Metadaten und aggregierte Byte-Werte liefern, keine Paketpayload.

### 7.8 GET /api/v1/network/exporters

Zweck:

- Zustand von NetFlow/IPFIX- und sFlow-Exportern anzeigen

Empfohlene Felder:

- `exporter_addr`
- `telemetry_type`
- `last_seen_at`
- `templates_ok`
- `sequence_gap_count`
- `decode_error_count`
- `sample_factor`
- `collector_node_id`
- `status`

### 7.9 POST /api/v1/network/capture/jobs

Zweck:

- expliziten Packet-Capture-Job anlegen

Nur `admin`.

Request sollte enthalten:

- `source_id`
- `target_host`
- `interface_name`
- `bpf_filter`
- `snaplen`
- `duration_seconds`
- `retention_hours`
- `reason`

Wichtige Validierungen:

- `duration_seconds` hart begrenzen
- `snaplen` hart begrenzen
- `bpf_filter` validieren
- `reason` verpflichtend fuer Auditierbarkeit

Antwort:

- `job_id`
- `status`
- `retention_until`

### 7.10 GET /api/v1/network/capture/jobs

Zweck:

- Liste und Verlauf von Capture-Jobs

Nur `admin`.

### 7.11 GET /api/v1/network/capture/jobs/{id}

Zweck:

- Status, Filter, Laufzeit und Artefaktmetadaten eines Capture-Jobs

### 7.12 POST /api/v1/network/capture/jobs/{id}/stop

Zweck:

- laufenden Capture-Job vorzeitig stoppen

### 7.13 GET /api/v1/network/capture/artifacts/{id}

Zweck:

- Metadaten eines Capture-Artefakts lesen

### 7.14 GET /api/v1/network/capture/artifacts/{id}/download

Zweck:

- kontrollierter Download eines PCAP- oder PCAPNG-Artefakts

Nur `admin`.

Wichtige Regel:

- Download wird auditiert.

## 8) Komponenten-Schemas

### 8.1 NetworkFlow

```yaml
NetworkFlow:
  type: object
  properties:
    id:
      type: string
      format: uuid
    source_id:
      type: string
      format: uuid
    telemetry_type:
      type: string
      enum: [netflow, ipfix, sflow, socket_observer]
    observed_at_start:
      type: string
      format: date-time
    observed_at_end:
      type: string
      format: date-time
    host_id:
      type: string
      nullable: true
    exporter_addr:
      type: string
      nullable: true
    src_ip:
      type: string
    dst_ip:
      type: string
    src_port:
      type: integer
      nullable: true
    dst_port:
      type: integer
      nullable: true
    protocol:
      type: string
    bytes:
      type: integer
    packets:
      type: integer
    connections:
      type: integer
    direction:
      type: string
      nullable: true
    app_hint:
      type: string
      nullable: true
    process_name:
      type: string
      nullable: true
    action:
      type: string
      nullable: true
    sample_factor:
      type: number
      format: float
    confidence:
      type: number
      format: float
    created_at:
      type: string
      format: date-time
  required:
    - id
    - source_id
    - telemetry_type
    - observed_at_start
    - observed_at_end
    - src_ip
    - dst_ip
    - protocol
    - bytes
    - packets
    - connections
    - sample_factor
    - confidence
    - created_at
```

### 8.2 NetworkMapNode

```yaml
NetworkMapNode:
  type: object
  properties:
    id:
      type: string
    label:
      type: string
    kind:
      type: string
      enum: [host, process, app, subnet, external]
    total_bytes:
      type: integer
    total_connections:
      type: integer
    risk_score:
      type: number
      format: float
  required: [id, label, kind, total_bytes, total_connections, risk_score]
```

### 8.3 NetworkMapEdge

```yaml
NetworkMapEdge:
  type: object
  properties:
    source:
      type: string
    target:
      type: string
    protocol:
      type: string
      nullable: true
    dst_port:
      type: integer
      nullable: true
    app_hint:
      type: string
      nullable: true
    bytes:
      type: integer
    packets:
      type: integer
    connections:
      type: integer
    blocked_count:
      type: integer
    anomaly_score:
      type: number
      format: float
  required: [source, target, bytes, packets, connections, blocked_count, anomaly_score]
```

### 8.4 InterfaceSampleView

```yaml
InterfaceSampleView:
  type: object
  properties:
    host_id:
      type: string
    interface_name:
      type: string
    ts:
      type: string
      format: date-time
    rx_bytes:
      type: integer
    tx_bytes:
      type: integer
    rx_drops:
      type: integer
    tx_drops:
      type: integer
    rx_errors:
      type: integer
    tx_errors:
      type: integer
    oper_state:
      type: string
  required: [host_id, interface_name, ts, rx_bytes, tx_bytes, rx_drops, tx_drops, rx_errors, tx_errors, oper_state]
```

### 8.5 SocketSample

```yaml
SocketSample:
  type: object
  properties:
    id:
      type: string
      format: uuid
    host_id:
      type: string
    ts:
      type: string
      format: date-time
    pid:
      type: integer
      nullable: true
    process_name:
      type: string
      nullable: true
    executable:
      type: string
      nullable: true
    local_ip:
      type: string
    local_port:
      type: integer
      nullable: true
    remote_ip:
      type: string
    remote_port:
      type: integer
      nullable: true
    protocol:
      type: string
    state:
      type: string
    bytes_in:
      type: integer
      nullable: true
    bytes_out:
      type: integer
      nullable: true
  required: [id, host_id, ts, local_ip, remote_ip, protocol, state]
```

### 8.6 CaptureJob

```yaml
CaptureJob:
  type: object
  properties:
    id:
      type: string
      format: uuid
    source_id:
      type: string
      format: uuid
    target_host:
      type: string
    interface_name:
      type: string
    bpf_filter:
      type: string
    snaplen:
      type: integer
    duration_seconds:
      type: integer
    status:
      type: string
      enum: [pending, running, stopping, completed, failed, expired]
    retention_until:
      type: string
      format: date-time
    started_at:
      type: string
      format: date-time
      nullable: true
    ended_at:
      type: string
      format: date-time
      nullable: true
  required: [id, source_id, target_host, interface_name, bpf_filter, snaplen, duration_seconds, status, retention_until]
```

## 9) Source-Typen im API-Contract

Der bestehende `Source.type`-Enum sollte spaeter erweitert werden um:

- `netflow`
- `sflow`
- `socket_observer`
- `packet_capture`

Wichtige Regel:

- `packet_capture` steht fuer verwalteten Capture-Zugriff, nicht fuer permanenten Traffic-Ingest.

## 10) Fehlerkonventionen

Fuer Capture und Collector-nahe Endpunkte sind zusaetzlich diese Fehlerfaelle wichtig:

- ungultiger BPF-Filter
- Host oder Interface nicht erreichbar
- Capture-Limit ueberschritten
- Artefakt abgelaufen
- Exporter unbekannt oder inaktiv
- Collector zurzeit nicht gesund

Diese Fehler bleiben im bestehenden JSON-Fehlerformat.

## 11) Empfehlung fuer die Umsetzung

Vor der eigentlichen Implementierung sollte dieser Draft in zwei Schritte ueberfuehrt werden:

1. neue Komponenten-Schemas in `spec/openapi.v1.yaml`
2. danach einzelne Endpunkte in kleinen, testbaren Slices, beginnend mit `GET /api/v1/network/flows/map` und `GET /api/v1/network/flows/summary`