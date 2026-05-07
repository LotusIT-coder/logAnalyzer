# Netzwerkfluss-Metriken und Visualisierung

Status: Proposed
Datum: 2026-05-06
Abhaengigkeiten: spec/openapi.v1.yaml, db/schema.sql, backend/app/domain/models.py, backend/app/parser/pipeline.py, backend/app/api/v1/metrics.py

## 1) Ziel

Ergaenzung des bestehenden Metrik- und Analysemodells um Netzwerkflussdaten, damit sichtbar wird:

- welches Geraet oder welcher Host sendet
- welche Anwendung oder welcher Prozess sendet
- wohin kommuniziert wird
- ueber welche Ports und Protokolle kommuniziert wird
- welche Volumina, Raten und Anomalien auftreten

Die Visualisierung soll nicht nur Tabellen liefern, sondern eine grafische Karte der Kommunikationsbeziehungen.

## 2) Wichtige Produktentscheidung

Es gibt zwei verschiedene Arten von "Karte":

- Topologie-Karte: Knoten und Kanten zwischen internen Hosts, Services, Prozessen und externen Zielen
- Geo-Karte: geographische Weltkarte mit Laendern/Standorten externer Ziele

Empfehlung fuer den naechsten Ausbauschritt:

- zuerst Topologie-Karte implementieren
- Geo-Karte nur optional danach ueber GeoIP-Enrichment hinzufuegen

Begruendung:

- Die vorhandenen Logdaten liefern mit hoher Wahrscheinlichkeit Host, Service, IP, Port und Event-Typ.
- Eine echte Weltkarte benoetigt sauberes GeoIP-Enrichment, was aktuell nicht Teil des Modells ist.
- Die Topologie-Karte liefert frueheren Nutzwert fuer Incident-Analyse und Anomalie-Erkennung.

## 3) Anschluss an das bestehende Datenmodell

Die aktuelle Event-Struktur ist dafuer bereits brauchbar:

- kanonische Event-Felder: timestamp, severity, service, host, environment, event_type, message
- flexible Zusatzfelder in Event.fields_json

Das bedeutet:

- ein erster Netzwerkfluss-Slice kann ohne neue Kern-Tabelle starten
- Parser-Profile koennen Netzwerkfelder direkt in fields_json ablegen
- Metrik-Endpunkte koennen auf diesen normalisierten Zusatzfeldern aggregieren

## 4) Empfohlene Normalisierung fuer Netzwerk-Events

Fuer Parser und Enrichment sollten folgende Schluessel in fields_json standardisiert werden:

- src_ip
- src_host
- src_port
- src_zone
- dst_ip
- dst_host
- dst_port
- dst_zone
- protocol
- app
- process
- direction
- bytes_in
- bytes_out
- packets_in
- packets_out
- action
- flow_id
- device_vendor
- device_product

Beispiele fuer Quellen:

- Firewall-Logs
- Proxy-Logs
- Netflow/IPFIX-Exports nach Vorverarbeitung
- Cloud Flow Logs
- EDR- oder Host-Firewall-Ereignisse
- Kubernetes Ingress/Egress- oder Service-Mesh-Logs

## 5) Sinnvolle erste Metriken

Der erste Metrik-Satz sollte auf direkte Investigation-Nutzung optimiert sein:

- Top Talkers: welche Quellen erzeugen die meisten Flows
- Top Destinations: welche Ziele werden am haeufigsten angesprochen
- Top Apps/Processes: welche Anwendung kommuniziert am meisten
- Traffic Volume: Bytes pro Zeitbucket
- Connection Count: Anzahl Verbindungen pro Zeitbucket
- Allowed vs Blocked: Verhaeltnis erlaubter zu blockierter Flows
- East-West vs North-South: intern-zu-intern vs intern-zu-extern
- New Destinations: Ziele, die in einem Referenzzeitraum zuvor nicht gesehen wurden
- Rare Ports: seltene oder neue Zielports
- Beaconing Score: regelmaessige, periodische Verbindungen

## 6) API-Vorschlag

Sinnvoll ist eine neue Metrics-Untergruppe statt Ueberladung der bestehenden Fehler-/Service-Endpunkte.

Vorschlag:

- GET /api/v1/metrics/network/timeseries
- GET /api/v1/metrics/network/top-talkers
- GET /api/v1/metrics/network/top-destinations
- GET /api/v1/metrics/network/top-apps
- GET /api/v1/metrics/network/map
- GET /api/v1/metrics/network/summary

Wichtige Query-Parameter:

- from / to
- bucket
- source_ids / source_paths
- src_ip / src_host
- dst_ip / dst_host
- app / process
- protocol
- direction
- action
- top_n

## 7) Datenformat fuer die grafische Karte

Fuer das Frontend sollte die Karte als Graph geliefert werden:

- nodes[]
- edges[]

Node-Felder:

- id
- label
- kind: host | service | app | external | subnet
- zone
- total_bytes
- total_connections
- risk_score

Edge-Felder:

- source
- target
- protocol
- dst_port
- bytes
- connections
- allowed_count
- blocked_count
- anomaly_score

Beispielhafte Gruppierung:

- interner Host -> App/Process -> externes Ziel
- oder kompakter: Host/App -> Ziel

## 8) Visualisierung im Frontend

Empfohlene Reihenfolge fuer die Visualisierung:

### 8.1 Phase 1: Topology Map

- Force-Directed Graph oder gerichteter Node-Link-Graph
- Knotenfarbe nach Zone oder Risiko
- Kantenstaerke nach Bytes oder Verbindungsanzahl
- Filter fuer Zeitfenster, Protokoll, Port, Host, App, Blocked/Allowed
- Klick auf Knoten oder Kante oeffnet gefilterte Event- bzw. Incident-Sicht

### 8.2 Phase 2: Sankey-Ansicht

- Quelle -> App -> Ziel
- besonders gut fuer Volumen- und Pfadverstaendnis

### 8.3 Phase 3: Geo-Karte

- nur wenn GeoIP-Enrichment vorhanden ist
- externe Ziele werden auf Laender oder Koordinaten abgebildet
- interne Ziele bleiben weiter in der Topologie-Ansicht

## 9) Empfohlene Frontend-Komponenten

Fuer die erste Umsetzung sind diese UI-Bausteine sinnvoll:

- neue Seite: NetworkPage
- KPI-Leiste: aktive Flows, neue Ziele, blockierte Flows, Gesamtvolumen
- Zeitreihe fuer Flow-Volumen und Connection Count
- Topology-Panel fuer Graph
- Tabellen fuer Top Talkers, Top Destinations, Top Apps
- Drilldown in Events/Incidents bei Klick auf Knoten oder Kante

## 10) Backend-Umsetzung in kleinen Schritten

### Phase A: Normalisierung

- Parser-Profiles dokumentieren, welche Netzwerkfelder nach fields_json gemappt werden
- optionale Hilfsfunktion zur Normalisierung von Aliasen wie source_ip -> src_ip, destination_ip -> dst_ip

### Phase B: Metriken

- neuen Endpunkt /metrics/network/summary
- neuen Endpunkt /metrics/network/timeseries
- neuen Endpunkt /metrics/network/map

### Phase C: Detection

- neue Ziele pro Host/App erkennen
- seltene Ports erkennen
- blockierte Verbindungen aggregieren
- Beaconing-Heuristik vorbereiten

## 11) Empfohlene Datenqualitaetsregeln

Damit die Metriken belastbar sind, sollten Netzwerk-Events als solche markiert werden:

- event_type = network_flow oder network_connection
- severity nicht als alleinige Quelle fuer Risiko verwenden
- direction nach Moeglichkeit vereinheitlichen: inbound | outbound | lateral
- action vereinheitlichen: allow | deny | drop | reset

## 12) Risiken

- unterschiedliche Logquellen verwenden stark abweichende Feldnamen
- ohne Alias-Normalisierung bleibt die Visualisierung unvollstaendig
- Geo-Karten ohne GeoIP fuehren schnell zu falscher Praezision
- sehr grosse Graphen brauchen Aggregation, Sampling oder Clustering

## 13) Empfehlung fuer den naechsten konkreten Umsetzungsschritt

Der naechste fachlich saubere Slice waere:

1. Netzwerkfeld-Normalisierung ueber Parser/Enrichment festlegen
2. neuen Backend-Endpunkt /api/v1/metrics/network/map einfuehren
3. neue Frontend-Seite mit Topology-Graph und Drilldown bauen

Der Endpunkt sollte initial nur aggregierte Host/App -> Ziel-Beziehungen liefern. Das passt sauber zum bestehenden Event-Modell und benoetigt noch keine separate Flow-Tabelle.