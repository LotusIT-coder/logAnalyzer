# Network Ingest Slice V1

Status: Draft
Datum: 2026-05-07
Abhaengigkeiten: network-collector-protocol.md, network-schema-migration-plan.md, backend/app/api/v1/ingestion.py

## 1) Ziel

Dieses Dokument definiert den ersten wirklich implementierbaren Backend-Slice fuer Netzwerktelemetrie.

Der Slice ist absichtlich klein:

- genau ein Ingest-Endpunkt
- genau ein Batch-Typ
- genau ein Zieldatenmodell
- keine Packet-Capture-Logik
- keine sFlow-Counter-Timeseries
- keine Socket-Samples

## 2) Scope des ersten Slices

Der erste Slice umfasst nur:

- `POST /api/v1/network/ingest/flows`
- authentisierte JSON-Batches
- Batch-Idempotenz ueber `batch_id`
- Persistenz in `network_flow`
- minimale Rueckmeldung an den Collector

Nicht im ersten Slice:

- partielle Annahme einzelner Items
- Download oder Verwaltung von Capture-Artefakten
- direkte NetFlow- oder sFlow-UDP-Dekodierung im Backend
- UI-Anbindung
- Materialized Views

## 3) Warum genau dieser Slice zuerst

Dieser Schnitt minimiert Risiko und schafft trotzdem einen tragfaehigen Pfad:

- Das Backend lernt den Zieltyp `network_flow`.
- Der Collector bekommt einen stabilen Upload-Vertrag.
- Idempotenz und Backpressure koennen frueh getestet werden.
- Alle spaeteren Quellen koennen auf denselben Ingestpfad normalisieren.

## 4) Endpoint-Definition

### POST /api/v1/network/ingest/flows

Auth:

- mindestens `write`
- spaeter optional eigenes Agent-Scope, aber fuer den ersten Slice reicht `write`

Request:

```json
{
  "batch_id": "1a17d617-41b5-4f81-a020-8bb9e8a1b94d",
  "collector_node_id": "collector-01",
  "source_id": "0f8fad5b-d9cb-469f-a165-70867728950e",
  "telemetry_type": "ipfix",
  "schema_version": 1,
  "created_at": "2026-05-07T10:15:00Z",
  "items": [
    {
      "item_id": "9dc36d4b-3c8b-4a83-b4c0-0aa88ccad0e6",
      "observed_at_start": "2026-05-07T10:14:50Z",
      "observed_at_end": "2026-05-07T10:15:00Z",
      "exporter_addr": "10.0.0.1",
      "observation_domain_id": 42,
      "src_ip": "10.0.10.12",
      "dst_ip": "10.0.20.8",
      "src_port": 51432,
      "dst_port": 5432,
      "protocol": "tcp",
      "bytes": 4096,
      "packets": 14,
      "connections": 1,
      "direction": "east_west",
      "action": "allow",
      "app_hint": "orders-api",
      "sample_factor": 1.0,
      "confidence": 1.0
    }
  ]
}
```

Response:

```json
{
  "batch_id": "1a17d617-41b5-4f81-a020-8bb9e8a1b94d",
  "status": "accepted",
  "accepted_count": 1,
  "rejected_count": 0,
  "duplicate": false,
  "errors": []
}
```

## 5) Minimale Pydantic-Schemas

Empfohlene Schemas fuer den ersten Slice:

- `NetworkFlowIngestItem`
- `NetworkFlowIngestBatch`
- `NetworkFlowIngestResponse`

### 5.1 NetworkFlowIngestItem

Pflichtfelder:

- `item_id`
- `observed_at_start`
- `observed_at_end`
- `src_ip`
- `dst_ip`
- `protocol`
- `bytes`
- `packets`
- `connections`
- `sample_factor`
- `confidence`

Optionale Felder:

- `exporter_addr`
- `observation_domain_id`
- `src_port`, `dst_port`
- `direction`
- `action`
- `app_hint`
- `process_name`
- `host_id`

### 5.2 NetworkFlowIngestBatch

Pflichtfelder:

- `batch_id`
- `collector_node_id`
- `source_id`
- `telemetry_type`
- `schema_version`
- `created_at`
- `items`

Validierungen:

- `telemetry_type` nur `netflow`, `ipfix`, `sflow`, `socket_observer`
- `schema_version == 1` fuer den ersten Slice
- `items` muss mindestens 1 Eintrag enthalten
- `batch_id` muss UUID sein

### 5.3 NetworkFlowIngestResponse

Pflichtfelder:

- `batch_id`
- `status`
- `accepted_count`
- `rejected_count`
- `duplicate`
- `errors`

## 6) Persistenzmodell fuer Idempotenz

Der erste Slice braucht neben `network_flow` eine kleine technische Tabelle, sonst wird Batch-Idempotenz unsauber.

Empfohlene Tabelle:

### network_ingest_batch

Felder:

- `batch_id UUID PRIMARY KEY`
- `collector_node_id TEXT NOT NULL`
- `source_id UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE`
- `telemetry_type TEXT NOT NULL`
- `schema_version INTEGER NOT NULL`
- `received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `status TEXT NOT NULL CHECK (status IN ('accepted','rejected'))`
- `item_count INTEGER NOT NULL`
- `error_text TEXT`

Zweck:

- erkennt Retries
- dokumentiert Fehlerfaelle
- macht Collector-Verhalten nachvollziehbar

## 7) Service-Schnitt

Empfohlene interne Aufteilung:

### API Layer

Datei:

- neue Route in `backend/app/api/v1/network.py`

Verantwortung:

- Auth
- Request-Validierung
- Aufruf der Ingest-Servicefunktion
- Response-Formung

### Service Layer

Datei:

- `backend/app/services/network_ingest.py`

Verantwortung:

- Duplicate-Pruefung ueber `network_ingest_batch`
- Persistenz der Batch-Metadaten
- Persistenz der `network_flow`-Zeilen
- Rueckgabe eines technischen Result-Objekts

### Schema Layer

Datei:

- Erweiterung in `backend/app/schemas/domain.py` oder neue `schemas/network.py`

Empfehlung:

- fuer den ersten Slice lieber `schemas/network.py`, um `domain.py` nicht weiter zu ueberladen

## 8) Ablauf im Happy Path

1. Collector sendet `POST /api/v1/network/ingest/flows`.
2. API validiert Token und Request-Shape.
3. Service prueft, ob `batch_id` bereits in `network_ingest_batch` existiert.
4. Falls nein: Batch-Metadaten mit Status `accepted` vorbereiten.
5. Alle Items werden nach `network_flow` geschrieben.
6. `network_ingest_batch` wird abgeschlossen.
7. API liefert `accepted_count = len(items)` zurueck.

## 9) Duplicate-Verhalten

Wenn `batch_id` bereits existiert und Status `accepted` hat:

- kein erneutes Schreiben in `network_flow`
- API antwortet mit:
  - `status = duplicate`
  - `duplicate = true`
  - `accepted_count = 0`
  - `rejected_count = 0`

Wenn `batch_id` bereits existiert und Status `rejected` hat:

- fuer V1 ebenfalls als Duplicate behandeln und nicht heimlich neu verarbeiten

Das ist strenger, aber klarer.

## 10) Fehlerverhalten

### 10.1 Fachliche Validierungsfehler

Beispiele:

- unbekannter `source_id`
- ungueltiger `telemetry_type`
- negative Zaehler
- leeres `items[]`

Ergebnis:

- HTTP 422 oder 400
- Batch wird nicht als `accepted` persistiert

### 10.2 Persistenzfehler

Beispiele:

- DB nicht erreichbar
- Constraint verletzt

Ergebnis:

- HTTP 500
- Collector retried mit derselben `batch_id`

## 11) Source-Pruefung

Der erste Slice sollte `source_id` nicht blind akzeptieren.

Pflichtpruefungen:

- Source existiert
- Source ist aktiviert
- Source-Typ passt zum Flow-Ingest, also mindestens `netflow`, `sflow` oder `socket_observer`

Empfehlung fuer V1:

- `ipfix` und `netflow` beide ueber Source-Typ `netflow`
- `sflow` ueber Source-Typ `sflow`
- `socket_observer` ueber Source-Typ `socket_observer`

## 12) TDD-Reihenfolge

Empfohlene Testreihenfolge:

### Test 1: Request wird angenommen

- gueltiger Batch liefert 200 oder 202 mit `accepted`

### Test 2: Flows werden persistiert

- nach Request existieren passende `network_flow`-Zeilen

### Test 3: Duplicate wird erkannt

- gleicher Request mit gleicher `batch_id` erzeugt keine zweite Persistenz

### Test 4: Unbekannte Source wird abgewiesen

- Batch wird nicht angenommen

### Test 5: Falscher Source-Typ wird abgewiesen

- `file`-Source darf keine Netzwerk-Flows ingestieren

### Test 6: Ungueltiger Item-Body faellt in Validation

- zum Beispiel fehlendes `src_ip`

## 13) Alembic-Slice fuer die erste Implementierung

Der erste Implementierungsslice braucht konkret nur:

1. Erweiterung von `source.type`
2. Tabelle `network_flow`
3. Tabelle `network_ingest_batch`

Nicht mehr.

Alles andere bleibt fuer spaetere Slices draussen.

## 14) Router-Einbindung

Empfohlene minimale Backend-Erweiterung:

- neue Datei `backend/app/api/v1/network.py`
- in `backend/app/api/v1/router.py` einbinden

Der erste Endpoint in diesem Router ist nur:

- `POST /network/ingest/flows`

Read-APIs fuer `GET /network/flows/*` koennen danach separat folgen.

## 15) Empfehlung als naechster Umsetzungsschritt

Wenn ich daraus den ersten echten Code-Slice ableiten soll, ist die sauberste Reihenfolge:

1. Alembic-Migration fuer `source.type`, `network_flow` und `network_ingest_batch`
2. Pydantic-Schemas fuer Batch und Response
3. Ingest-Service mit Duplicate-Pruefung
4. API-Endpoint `POST /api/v1/network/ingest/flows`
5. API- und Service-Tests fuer Happy Path, Duplicate und Source-Validation

Das ist klein genug fuer einen kontrollierten TDD-Slice und gross genug, um den gesamten spaeteren Collector-Pfad tragfaehig zu machen.