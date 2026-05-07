# Network Collector To Backend Protocol

Status: Draft
Datum: 2026-05-07
Abhaengigkeiten: network-observability-architecture.md, network-api-contract-draft.md

## 1) Ziel

Dieses Dokument definiert das Transport- und Zuverlaessigkeitsmodell zwischen Collector- oder Host-Agent-Prozessen und dem Backend.

Ziel ist ein Protokoll, das spaeter nicht an den typischen Problemen scheitert:

- kurze Backend-Ausfaelle
- Retry-Duplikate
- Reihenfolgeprobleme
- unkontrollierter Speicherwuchs
- schwer erklaerbare Datenverluste

## 2) Nicht-Ziele

Bewusst nicht im ersten Schritt:

- Kafka- oder NATS-Pflicht
- bidirektionales Streaming ueber WebSockets
- komplexe Exactly-Once-Semantik
- Raw-PCAP-Upload im Standard-Ingest-Pfad

## 3) Empfohlene Transportform

Empfehlung fuer Phase A und B:

- HTTP-basiertes Batch-Push-Modell vom Collector zum Backend
- `application/json` fuer den ersten Implementierungsslice
- spaeter optional `application/x-msgpack` als Optimierung

Warum kein UDP direkt ins Backend:

- Die UDP-Welt bleibt im Collector.
- Das Backend bekommt bereits normalisierte, authentisierte und gepufferte Batches.

## 4) Prozessrollen

### 4.1 Collector

Verantwortung:

- Empfang und Dekodierung von NetFlow/IPFIX und sFlow
- Empfang von Host-Agent-Daten
- Normalisierung auf das Zielmodell
- lokales Puffern, Retry, Health-Metriken
- Batch-Upload an das Backend

### 4.2 Host-Agent

Verantwortung:

- lokale Socket- und Interface-Daten erfassen
- optionale Capture-Jobs ausfuehren
- normalisierte Daten an Collector oder direkt an Backend pushen

Empfehlung:

- In Multi-Host-Szenarien an zentralen Collector pushen.
- In Ein-Host-Setups darf ein lokaler Host-Agent direkt zum Backend pushen.

### 4.3 Backend

Verantwortung:

- Agent oder Collector authentisieren
- Batches validieren
- idempotent persistieren
- partielle oder komplette Annahme transparent zurueckmelden

## 5) Authentisierung

Empfohlene erste Variante:

- dedizierte Bearer-Tokens pro Collector oder Agent
- eigene Source- oder Agent-Zuordnung in `source.config_json`

Spaeter moeglich:

- mutual TLS
- rotierbare Agent-Zertifikate

Wichtige Regel:

- kein Shared-Admin-Token fuer alle Collector-Instanzen.

## 6) Zielendpunkte fuer Ingest

Empfohlene interne Ingest-Endpunkte:

- `POST /api/v1/network/ingest/flows`
- `POST /api/v1/network/ingest/interfaces`
- `POST /api/v1/network/ingest/sockets`
- `POST /api/v1/network/ingest/exporters`

Capture-Jobs laufen nicht ueber denselben Pfad, sondern ueber administrative Endpunkte.

## 7) Batch-Struktur

Jeder Upload sollte genau einen Batch enthalten.

Empfohlene Huelle:

```json
{
  "batch_id": "4f7f29b1-3ad8-4e21-9982-3a1cc6648d2a",
  "collector_node_id": "collector-01",
  "source_id": "1b2c3d4e-aaaa-bbbb-cccc-1234567890ab",
  "telemetry_type": "ipfix",
  "created_at": "2026-05-07T10:00:00Z",
  "schema_version": 1,
  "items": []
}
```

Pflichtfelder:

- `batch_id`
- `collector_node_id`
- `source_id`
- `telemetry_type`
- `created_at`
- `schema_version`
- `items`

## 8) Item-Struktur

Jeder `items[]`-Eintrag ist bereits normalisiert und passt auf genau einen Zieltyp.

Beispiel fuer Flow-Batch-Item:

```json
{
  "item_id": "e4f74d77-51f1-4ee6-9912-a2af12cf3cf1",
  "observed_at_start": "2026-05-07T09:59:45Z",
  "observed_at_end": "2026-05-07T10:00:00Z",
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
```

Wichtige Regel:

- `item_id` muss innerhalb eines Batches eindeutig sein.

## 9) Idempotenz und Deduplikation

Es gibt spaeter fast sicher Retries. Deshalb braucht das Protokoll eine klare Idempotenzstrategie.

Empfehlung:

1. `batch_id` identifiziert den Upload-Versuch eindeutig.
2. Das Backend speichert angenommene `batch_id`s mit Status.
3. Ein identischer Retry mit derselben `batch_id` wird als bereits verarbeitet erkannt.
4. Optional kann zusaetzlich pro Item ein technischer Fingerprint gespeichert werden.

Wichtige Designregel:

- Im ersten Schritt reicht Batch-Idempotenz. Item-genaue Idempotenz kann spaeter kommen, wenn mehrere Writer pro Quelle entstehen.

## 10) Antwortmodell des Backends

Empfohlene Standardantwort:

```json
{
  "batch_id": "4f7f29b1-3ad8-4e21-9982-3a1cc6648d2a",
  "status": "accepted",
  "accepted_count": 500,
  "rejected_count": 0,
  "duplicate": false,
  "errors": []
}
```

Moegliche `status`-Werte:

- `accepted`
- `accepted_with_errors`
- `duplicate`
- `rejected`

Empfehlung fuer Phase A:

- ganze Batches akzeptieren oder verwerfen
- partielle Fehler erst spaeter einfuehren, wenn echter Bedarf besteht

## 11) Retry-Verhalten

Empfohlene Regeln fuer Collector und Agent:

1. Bei HTTP 2xx gilt der Batch als abgeschlossen.
2. Bei Netzwerkfehlern oder HTTP 5xx wird mit Backoff erneut versucht.
3. Bei HTTP 4xx wird der Batch nicht endlos retried, sondern als fachlich gescheitert markiert.
4. Jeder Retry behaelt dieselbe `batch_id`.

Empfohlenes Backoff:

- exponential backoff mit Jitter
- Obergrenze von einigen Minuten

## 12) Lokaler Spool

Ein lokaler Spool ist Pflicht, sobald der Collector nicht-fluechtige Daten verlieren darf.

Empfohlene Eigenschaften:

- append-only Batch-Dateien oder kleine SQLite-basierte Queue
- bounded disk usage
- FIFO-Replay
- Crash-sicherer Zustand

Empfehlung fuer Phase A:

- einfacher Dateispool je Batch im JSON-Format
- Dateiname enthaelt Zeit plus `batch_id`

Pflichtmetriken:

- Anzahl wartender Batches
- belegter Spool-Speicher
- aeltester Batch im Spool
- Drop-Count bei vollem Spool

## 13) Reihenfolge und Zeitsemantik

Das System darf nicht voraussetzen, dass Daten in perfekter Reihenfolge eintreffen.

Daher muss jedes Item besitzen:

- Beobachtungszeit
- Collector-Eingangszeit oder Batch-Zeit

Wichtige Regel:

- UI- und Aggregationslogik arbeitet auf beobachteter Zeit, nicht nur auf Insert-Zeit.

## 14) Fehlerklassen

Fehler muessen trennscharf klassifiziert werden:

- Transportfehler
- Auth- oder Tokenfehler
- Schemafehler im Batch
- fachliche Validierungsfehler
- Persistenzfehler
- Ueberlast oder Backpressure

Empfehlung:

- Collector-Health-Ansicht zeigt diese Fehler getrennt an.

## 15) Schema-Versionierung

Jeder Batch braucht eine `schema_version`.

Regeln:

1. additive Felder duerfen innerhalb einer Minor-Weiterentwicklung eingefuehrt werden
2. breaking changes brauchen eine neue Schema-Version
3. Collector und Backend muessen Versionsinkompatibilitaeten explizit loggen

## 16) Groessen- und Limits

Damit spaeter keine grossen Problem-Batches entstehen, sollten von Anfang an harte Limits gelten.

Empfehlung:

- maximale Items pro Batch
- maximale komprimierte und unkomprimierte Batch-Groesse
- maximale Capture-Artefaktgroesse pro Job

Sinnvolle Startwerte sind umgebungsabhaengig, aber die Existenz der Limits ist wichtiger als der exakte Defaultwert.

## 17) Compression

Empfehlung:

- HTTP-Request-Compression spaeter aktivierbar
- fuer Phase A optional, nicht verpflichtend

Wichtige Regel:

- Compression erst aktivieren, wenn Logging, Timeouts und Max-Body-Handling sauber sind.

## 18) Sicherheitsregeln fuer Capture-Artefakte

Capture-Artefakte gehoeren nicht in den normalen Ingest-Pfad.

Empfehlung:

- nur Metadaten ueber API persistieren
- eigentliche Artefakte in kontrolliertem Storage halten
- Download nur ueber admin-geschuetzten Endpunkt
- jeder Zugriff auditieren

## 19) Observability des Protokolls

Collector und Backend sollten mindestens diese Kennzahlen fuehren:

- empfangene Batches pro Typ
- akzeptierte und abgelehnte Batches
- Retry-Count
- Duplicate-Count
- Spool-Groesse
- aelteste wartende Batch-Zeit
- Decoder-Fehler pro Quelle

## 20) Umsetzungsempfehlung

Die erste produktive Variante sollte so klein wie moeglich bleiben:

1. Flow-Ingest via `POST /api/v1/network/ingest/flows`
2. JSON-Batches mit `batch_id` und `schema_version`
3. lokaler Dateispool
4. Retry mit Backoff und Batch-Idempotenz

Damit bekommt ihr frueh ein robustes, nachvollziehbares Protokoll, ohne direkt Messaging-Infrastruktur oder komplexe Exactly-Once-Semantik einzufuehren.