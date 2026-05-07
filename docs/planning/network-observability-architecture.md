# Netzwerk-Telemetrie Architekturplan

Status: Proposal
Datum: 2026-05-07
Abhaengigkeiten: mvp-scope-freeze.md, technical-guardrails.md

## 1) Zielbild

Das Produkt soll kuenftig nicht nur Logs analysieren, sondern auch Netzwerkverkehr aus vier Quellen verarbeiten:

- NetFlow/IPFIX von Routern, Firewalls und Switches
- sFlow von Netzkomponenten
- lokale Socket- und Interface-Beobachtung auf Linux-Hosts
- selektives Packet Capture fuer Debugging, Forensik und Deep Inspection

Wichtig: Diese vier Datenarten duerfen nicht als unsortierte Event-Masse in die bestehende Event-Tabelle gedrueckt werden. Sie brauchen ein eigenes Telemetrie-Modell mit klarer Normalisierung, definierter Retention und sauberer Trennung von Erfassung, Speicherung und Darstellung.

## 2) Harte Architekturentscheidungen

Diese Entscheidungen sollten frueh fixiert werden, damit spaeter keine strukturellen Probleme entstehen:

1. Der FastAPI-Webprozess sniffed keine Interfaces und nimmt keine NetFlow- oder sFlow-UDP-Pakete direkt entgegen.
2. Netzwerktelemetrie wird in einem separaten Collector-Layer aufgenommen und erst danach normalisiert an das Backend uebergeben.
3. `Event` bleibt ein Analyse- und Korrelationsobjekt, aber nicht das Rohdaten- oder Primärmodell fuer Netzwerkverkehr.
4. Der Standard-Speicher fuer Netzwerktelemetrie ist Flow- und Counter-basiert, nicht Payload-basiert.
5. Volles Packet Capture ist standardmaessig aus, zeitlich begrenzt und stark zugriffsgeschuetzt.
6. Der Collector-Prozess laeuft mit minimalen Linux-Capabilities; der Webprozess bleibt unprivilegiert.
7. Jede neue Telemetrieart wird erst im Contract beschrieben und dann implementiert.

## 3) Empfehlung zur Einfuehrungsreihenfolge

Die Reihenfolge sollte bewusst risikoarm sein:

1. Gemeinsames Netzwerk-Domaenenmodell und Storage einziehen.
2. NetFlow/IPFIX als erste echte Netzwerkquelle umsetzen.
3. sFlow darauf aufsetzen.
4. Lokale Socket- und Interface-Beobachtung pro Host einfuehren.
5. Packet Capture zuletzt und nur selektiv freischalten.

Begruendung:

- NetFlow/IPFIX und sFlow liefern bereits aggregierte Flows und sind betrieblich deutlich billiger als dauerhafte Paketmitschnitte.
- Lokale Socket-Beobachtung bringt Host- und Prozesskontext, ist aber Linux-spezifischer und technisch tiefer.
- Packet Capture ist in Bezug auf Privilegien, Datenschutz, Speicherbedarf und Auswertung mit Abstand der teuerste Baustein.

## 4) Zielarchitektur

Empfohlene Zielarchitektur in vier Ebenen:

1. Erfassungsebene
   - NetFlow/IPFIX-Collector
   - sFlow-Collector
   - Host-Agent fuer Socket- und Interface-Beobachtung
   - Optionaler Packet-Capture-Agent

2. Normalisierungs- und Ingest-Ebene
   - vereinheitlicht alle Quellen in ein gemeinsames Netzwerkmodell
   - fuehrt Deduplizierung, Zeitnormalisierung, Sampling-Normalisierung und Enrichment aus
   - uebergibt gebatchte Datensaetze an das Backend

3. Persistenz- und Analyse-Ebene
   - speichert Flows, Interface-Counter, Socket-Samples und Capture-Metadaten in eigenen Tabellen
   - erzeugt daraus Aggregationen, Rule-Inputs, Anomalien und optionale abgeleitete Events

4. API- und UI-Ebene
   - bestehende Netzwerkansicht liest kuenftig aus dem Flow-Modell statt aus frei interpretierten Event-Feldern
   - neue Ansichten fuer Interfaces, Sockets, Capture-Sessions und Exporter-Gesundheit

## 5) Empfohlene Prozessgrenzen

Um spaetere Probleme mit Rechten, Last und Stabilitaet zu vermeiden, sollten folgende Prozessgrenzen gelten:

- `backend-api`: FastAPI, Auth, UI-APIs, Rule-Engine, Persistenz, AI, Auditing
- `network-collector`: nimmt NetFlow/IPFIX und sFlow an, oder bekommt Host-Agent-Daten, normalisiert und puffert
- `host-agent`: laeuft optional auf zu beobachtenden Hosts fuer Socket-/Interface-Daten und lokale Capture-Jobs

Wichtige Regel:

- Exporter und Interfaces sprechen nie direkt mit dem FastAPI-Prozess.

## 6) Quelltypen und Collector-Verantwortung

### 6.1 NetFlow/IPFIX

NetFlow/IPFIX sollte der erste produktive Netzwerkpfad werden.

Collector-Verantwortung:

- UDP-Socket auf dediziertem Port
- Template-Management pro Exporter und Observation Domain
- Sequenz- und Template-Fehler erkennen und zaehlen
- Sampling-Rate, Input-/Output-Interface und Exporter-IP erfassen
- Normalisierung auf gemeinsames Flow-Modell

Wichtige Felder im Zielmodell:

- exporter_addr
- observation_domain_id
- flow_start
- flow_end
- src_ip, dst_ip
- src_port, dst_port
- protocol
- bytes, packets
- tcp_flags
- next_hop, ingress_if, egress_if
- samplerate
- direction
- app_hint, action, nat_hint optional

Entscheidung:

- IPFIX und NetFlow v9 zuerst, NetFlow v5 nur falls aus Bestandsumgebungen zwingend noetig.

### 6.2 sFlow

sFlow sollte ueber denselben Collector-Layer laufen, aber als eigene Decoder-Pipeline.

Collector-Verantwortung:

- Datagramme dekodieren
- Counter-Samples von Flow-Samples trennen
- Sample-Rate pro Datensatz sauber normalisieren
- Interface-Counter in Interface-Timeseries ueberfuehren
- Flow-Samples in das gemeinsame Flow-Modell projizieren

Wichtige Unterschiede zu NetFlow/IPFIX:

- sFlow ist sampling-basiert und liefert haeufig Counter plus Header-Samples
- Hochrechnungen muessen transparent und nachvollziehbar sein
- Unsicherheit und Sample-Faktor sollten im Modell erhalten bleiben

### 6.3 Lokale Socket- und Interface-Beobachtung

Diese Quelle beantwortet die Frage: Welcher lokale Prozess oder Container kommuniziert mit welchem Ziel?

Empfohlene Architektur:

- Interface-Counter ueber Netlink oder eine stabile Systembibliothek lesen
- Socket-Events bevorzugt ueber eBPF erfassen
- Fallback fuer reduzierte Umgebungen: periodische Snapshot-Erfassung ueber `/proc` oder `ss`

Host-Agent-Verantwortung:

- Verbindungen beobachten: connect, accept, close, reset
- Prozess- und Container-Metadaten anreichern
- Interface-Counter periodisch erfassen
- Verfuegbarkeits- und Drop-Metriken selbst berichten

Wichtige Felder:

- host_id
- pid, process_name, executable, user
- cgroup_id, container_id optional
- local_ip, local_port
- remote_ip, remote_port
- protocol
- socket_state
- bytes_in, bytes_out sofern verfuegbar
- interface_name
- rx_bytes, tx_bytes, drops, errors, speed

Harte Empfehlung:

- Host-Prozesskontext kommt aus dem Host-Agent, nicht aus spaeterem Reverse-Lookup im Backend.

### 6.4 Packet Capture

Packet Capture nur als selektive, kurzlebige und streng kontrollierte Funktion einplanen.

Nicht empfohlen:

- dauerhafter Vollmitschnitt aller Interfaces
- Payload-Speicherung als Standardpfad
- Mitschnitt direkt im Web-Backend

Empfohlene Einsatzzwecke:

- zeitlich begrenzte Debug-Sitzung
- forensische Nachsicherung eines Incidents
- tiefe Analyse eines bereits auffaelligen Flows oder Hosts

Capture-Agent-Verantwortung:

- BPF-Filter anwenden
- Snaplen begrenzen
- Rolling Ring Buffer oder kurze Capture-Jobs
- Artefakte verschluesselt und mit kurzer Retention ablegen
- nur Metadaten standardmaessig ins Backend senden

## 7) Gemeinsames Domaenenmodell

Damit spaeter keine Quelle die Architektur dominiert, braucht es ein gemeinsames Netzwerkmodell.

Empfohlene Kernobjekte:

### 7.1 Source-Erweiterung

Die bestehende `source`-Tabelle kann als Konfigurationsanker erhalten bleiben, sollte aber um Netzwerkquellen erweitert werden:

- `netflow`
- `sflow`
- `socket_observer`
- `packet_capture`

Vorteil:

- bestehende Rechte, Filter, UI-Patterns und Audit-Mechaniken bleiben wiederverwendbar.

### 7.2 NetworkFlow

Primäres Modell fuer alle flow-aehnlichen Daten.

Empfohlene Felder:

- id
- source_id
- collector_node_id
- telemetry_type
- observed_at_start
- observed_at_end
- host_id optional
- exporter_addr optional
- src_ip, dst_ip
- src_port, dst_port
- protocol
- bytes
- packets
- connections
- direction
- app_hint
- action
- sample_factor
- confidence
- process_name optional
- container_id optional
- raw_ref optional
- created_at

### 7.3 InterfaceSample

Zeitreihe pro Host und Interface.

Empfohlene Felder:

- id
- source_id
- host_id
- interface_name
- ts
- rx_bytes, tx_bytes
- rx_packets, tx_packets
- rx_drops, tx_drops
- rx_errors, tx_errors
- speed_bps optional
- oper_state

### 7.4 SocketSample

Host-zentrierter Verbindungs- und Prozesskontext.

Empfohlene Felder:

- id
- source_id
- host_id
- ts
- pid
- process_name
- executable
- user_name
- container_id optional
- local_ip, local_port
- remote_ip, remote_port
- protocol
- state
- bytes_in optional
- bytes_out optional
- lifetime_ms optional

### 7.5 CaptureJob und CaptureArtifact

Steuern selektive Packet-Capture-Sessions.

Empfohlene Felder fuer `capture_job`:

- id
- source_id
- requested_by
- target_host
- interface_name
- bpf_filter
- snaplen
- started_at
- ended_at
- retention_until
- status

Empfohlene Felder fuer `capture_artifact`:

- id
- job_id
- object_path oder local_path
- sha256
- packet_count
- byte_size
- encrypted
- created_at

## 8) Ableitung in bestehende Funktionen

Die bestehende Netzwerkseite sollte nicht entfernt, sondern neu unterfuettert werden.

Empfohlene Regeln:

- `network_map` liest mittelfristig aus `network_flow`
- heutige Event-basierte Netzwerkfelder bleiben als Kompatibilitaetsmodus erhalten
- Incidents und Rules koennen auf `network_flow`, `socket_sample` und `interface_sample` zugreifen
- nur relevante Netzwerk-Anomalien werden optional in `event` projiziert

Das verhindert, dass das Event-Modell unkontrolliert mit Netzwerkdetails ueberladen wird.

## 9) Ingest- und Transportdesign

### 9.1 Collector zu Backend

Empfehlung:

- gebatchter Push vom Collector zum Backend
- JSON oder MessagePack fuer interne Batches
- idempotente Batch-IDs fuer Wiederholungen
- serverseitige Acknowledge-Semantik

### 9.2 Lokaler Puffer

Jeder Collector braucht einen lokalen, begrenzten Puffer fuer Backpressure:

- Memory Queue fuer kurze Spitzen
- lokaler Disk-Spool fuer laengere API-Ausfaelle
- Drop- und Retry-Zaehler als Health-Metriken

### 9.3 Zeit und Ordnung

Es muss akzeptiert werden, dass Daten spaeter oder ausser Reihenfolge eintreffen.

Deshalb:

- `observed_at_start` und `observed_at_end` getrennt von `created_at`
- Exporter-Uhrzeit und Collector-Eingangszeit unterscheiden
- Toleranzfenster fuer spaete Daten im Aggregator definieren

## 10) Speicher- und Performance-Strategie

Um spaeter keine Lastprobleme zu bekommen, sollten die Tabellen fuer Netzwerktelemetrie frueh auf Volumen ausgelegt werden.

Empfehlungen:

- `network_flow` nach Zeit partitionieren, mindestens taeglich oder woechentlich
- BRIN-Index auf Zeitspalten, B-Tree auf haeufige Filterdimensionen
- Rohdaten append-only schreiben
- schwere UI-Abfragen ueber voraggregierte Sichten oder Materialized Views bedienen
- Raw-Payload nie dauerhaft in PostgreSQL speichern
- Packet-Artefakte ausserhalb der Haupttabellen halten

Hot-Dimensionen fuer Indizes:

- observed_at_end
- source_id
- src_ip
- dst_ip
- process_name
- host_id
- protocol
- dst_port

## 11) Sicherheits- und Datenschutzmodell

Gerade bei Packet Capture und Host-Socket-Daten entsteht schnell ein Compliance-Problem. Deshalb sollten folgende Regeln verbindlich sein:

1. Payload-Capture standardmaessig deaktiviert.
2. Capture nur mit explizitem Job, Audit-Log und kurzer Retention.
3. Zugriff auf Capture-Artefakte nur fuer hohe Rollen und getrennte Scopes.
4. Host-Agent und Capture-Agent laufen mit minimalen Capabilities statt als Vollroot-Prozesse.
5. Geheimnisse und Agent-Token rotierbar halten.
6. Sensible Netzwerkfelder fuer AI-Pipelines maskierbar machen.

Linux-seitig bedeutet das typischerweise:

- fuer Packet Capture getrennte Service-Unit mit minimalen Rechten
- fuer eBPF getrennte Agent-Rechte und klar dokumentierte Kernel-Voraussetzungen
- niemals den Webserver mit CAP_NET_RAW oder vergleichbaren Rechten starten

## 12) API-Contract und UI-Contract

Gemass den bestehenden Guardrails muss der Contract vor die Implementierung.

Empfohlene neue API-Gruppen:

- `/api/v1/network/flows`
- `/api/v1/network/flows/map`
- `/api/v1/network/interfaces`
- `/api/v1/network/interfaces/timeseries`
- `/api/v1/network/sockets`
- `/api/v1/network/exporters`
- `/api/v1/network/capture/jobs`
- `/api/v1/network/capture/artifacts`

Die bestehende Metrikroute fuer `network/map` kann als Uebergangs-API bleiben, sollte aber spaeter auf das neue Modell zeigen.

## 13) Test- und Abnahmestrategie

Damit das System spaeter nicht unter Realbedingungen scheitert, sind frueh folgende Testarten noetig:

1. Decoder-Tests mit Golden-Files fuer NetFlow/IPFIX und sFlow.
2. PCAP-Replay-Tests fuer Packet-Capture-Pipelines.
3. Host-Agent-Tests fuer Socket-Lifecycle und Interface-Samples.
4. Lasttests mit realistischer Flow-Rate.
5. Resilienztests fuer Collector-Neustart, API-Ausfall und Spool-Recovery.
6. Zeit- und Reihenfolgetests fuer verspaetete Flows und Clock-Skew.
7. Security-Tests fuer Capture-Berechtigungen und Scope-Trennung.

Abnahmekriterien pro Quelle:

- korrekte Dekodierung
- definierte Verlust- und Retry-Sichtbarkeit
- stabile Retention
- nachvollziehbare Sampling-Herkunft
- UI-Abfragen unter Last akzeptabel

## 14) Technische Risiken und Gegenmassnahmen

### Risiko 1: Event-Modell wird ueberladen

Gegenmassnahme:

- Netzwerkdaten in eigenen Tabellen halten
- Event nur fuer abgeleitete Erkenntnisse nutzen

### Risiko 2: Privilegierter Webprozess

Gegenmassnahme:

- Capture und eBPF strikt in separaten Agenten kapseln

### Risiko 3: Unkontrolliertes Datenvolumen

Gegenmassnahme:

- Flow first, Payload spaeter und selektiv
- Retention und Partitionierung ab Tag 1

### Risiko 4: Quellenspezifische Sonderlogik verunreinigt APIs

Gegenmassnahme:

- gemeinsames Normalisierungsmodell mit `telemetry_type`, `sample_factor`, `confidence`

### Risiko 5: UI basiert auf unscharfen Event-Feldern

Gegenmassnahme:

- Netzwerk-UI schrittweise auf `network_flow` migrieren

## 15) Konkrete Roadmap

### Phase A: Architektur-Fundament

- OpenAPI und SQL fuer Netzwerk-Domaene entwerfen
- `source.type` fuer Netzwerkquellen erweitern
- Tabellen fuer `network_flow`, `interface_sample`, `socket_sample`, `capture_job`, `capture_artifact` anlegen
- API fuer Flow-Lesen und Topologie definieren

Exit-Kriterium:

- Netzwerkseite kann auf neuem Modell aufsetzen, auch wenn noch nur Testdaten vorhanden sind

### Phase B: NetFlow/IPFIX

- Collector-Prozess einziehen
- Exporter, Templates, Sequenzfehler und Sampling modellieren
- erste UI fuer Flows, Topologie und Exporter-Gesundheit

Exit-Kriterium:

- produktive NetFlow/IPFIX-Flows erscheinen stabil in UI und APIs

### Phase C: sFlow

- sFlow-Decoder und Counter-Samples integrieren
- Interface-Timeseries und Sample-Faktor sichtbar machen

Exit-Kriterium:

- Switch- und Netzwerkgeraete koennen ueber sFlow sinnvoll eingebunden werden

### Phase D: Socket- und Interface-Agent

- Host-Agent auf Linux einziehen
- Prozess-, Container- und Interface-Kontext mit Flows korrelieren

Exit-Kriterium:

- UI beantwortet belastbar, welcher lokale Prozess wohin kommuniziert

### Phase E: Selektives Packet Capture

- Capture-Jobs, Artefaktverwaltung und Rollenrechte implementieren
- forensische und Debug-Pfade an Incident- und Flow-Drilldown anbinden

Exit-Kriterium:

- Mitschnitte sind gezielt, auditierbar und betrieblich kontrollierbar

## 16) Empfehlung als Softwarearchitekt

Wenn nur eine Leitentscheidung frueh getroffen werden soll, dann diese:

- Baut zuerst eine saubere Netzwerk-Domaene und einen Collector-Layer, nicht sofort Packet Capture.

Der groesste spaetere Schaden entsteht nicht durch fehlende Features, sondern durch falsche Prozessgrenzen und ein ueberladenes Event-Modell. Wenn die Architektur von Anfang an `network_flow` als Primarmodell, getrennte Collector-Prozesse und selektives Packet Capture vorsieht, bleiben NetFlow, sFlow, Host-Beobachtung und spaetere forensische Features sauber erweiterbar.