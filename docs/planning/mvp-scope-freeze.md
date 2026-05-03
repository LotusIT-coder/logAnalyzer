# MVP Scope Freeze (Punkt 1)

Status: Frozen
Datum: 2026-05-03
Projekt: Open-Source Log Analyzer
Freigabe: Produktowner bestaetigt alle Scope-Punkte am 2026-05-03

## 1) Produktziel fuer den MVP (fixiert)

Der MVP liefert einen lokal installierbaren Log Analyzer mit:

- lokalem Backend (auf dem Rechner des Betreibers)
- API-basierter Architektur
- flexibel einbindbarem Frontend (Standalone + Embed)
- Einbindung in externe Website (hier: Wego) per Embed
- oeffentlicher, abgesicherter Erreichbarkeit ueber DuckDNS
- lokaler KI-Analyse ueber Ollama mit waehlbaren Modellen

## 2) Verbindliche Contracts (fixiert)

Diese beiden Artefakte sind ab jetzt der technische Vertrag fuer Implementierung und Tests:

- API Contract: spec/openapi.v1.yaml
- Datenmodell Contract: db/schema.sql

Regel:

- Neue Features werden nur umgesetzt, wenn sie in mindestens einem Contract abgebildet sind.
- Breaking Changes am Contract erfordern explizite Versionierung (v1.x -> v2).

## 3) Funktionaler MVP-Scope (in)

### 3.1 Ingestion und Parsing

- Log-Quelle Typ file
- Quelle anlegen, aendern, testen
- Manuelle Ingestion ausloesen
- Parser-Test Endpoint
- Parser-Pipeline mit json, regex, grok, key-value (Basisumfang)

### 3.2 Events

- Events persistieren
- Events filtern (Zeitfenster, Severity, Service, Host, Query)
- Event-Detailansicht per API
- Event-Stream via SSE

### 3.3 Rules und Incidents

- Regeln anlegen/lesen/aendern
- Dry-Run fuer Regeln
- Incident-Erzeugung und Status-Workflow
- Incident-Liste + Incident-Detail

### 3.4 KI (Ollama)

- Verfuegbare Modelle abrufen
- Analyse fuer Zeitfenster starten
- Analyse fuer Incident starten
- Kontextueller Chat auf Event-/Incident-Basis
- Asynchrone AI-Jobs mit Statusabfrage

### 3.5 Dashboard-Metriken

- Timeseries
- Top Errors
- Top Services
- Error Rate

### 3.6 Sicherheit (Minimum)

- Bearer-Auth fuer geschuetzte Endpoints
- API-Token mit Scopes
- Audit-Log Endpoint
- CORS nur fuer freigegebene Domain(s)
- TLS am Reverse Proxy (Deployment)

### 3.7 Frontend

- API-faehiges Frontend als eigene App
- Embed-Widget fuer externe Website (Wego)

## 4) Non-Goals fuer den MVP (out)

Diese Punkte werden bewusst nicht im MVP umgesetzt:

- Multi-Tenant Mandantenfaehigkeit
- Cluster-/Distributed Processing
- Automatische Parser-Lernverfahren
- Vollstaendige SIEM-Integration
- Feingranulare RBAC-Rollenmatrix (ueber Token-Scopes hinaus)
- Mobile App
- Vollautomatische Incident-Routing-Workflows
- Hochverfuegbarkeits-Setup

## 5) Architektur- und Betriebsgrenzen (MVP)

- Eine produktive Instanz auf lokalem Host
- Eine primäre Datenbankinstanz (PostgreSQL)
- Optional Redis erst ab Performance-Bedarf
- Keine verpflichtende Queue-Infrastruktur im MVP
- Deploymentziel: Wego-Frontend + DuckDNS + lokaler Backend-Host

## 6) Definition of Done fuer Punkt 1

Punkt 1 gilt als abgeschlossen, wenn:

- Produktziel fuer MVP ist dokumentiert und bestaetigt.
- OpenAPI und SQL sind als verbindliche Contracts markiert.
- Non-Goals sind klar dokumentiert.
- Keine offenen Scope-Konflikte mehr vorhanden.

## 7) Bestaetigungen durch den Produktowner

Alle folgenden Punkte wurden am 2026-05-03 explizit mit "ja" bestaetigt:

1. Startquelle im MVP nur file-logs.
2. Auth im MVP nur API-Token (ohne vollwertiges User-Login).
3. Embed zunaechst read-only (kein Schreibzugriff).
4. Incident-Statusmodell exakt: open, investigating, resolved, false_positive.
5. Non-Goals wie dokumentiert akzeptiert.

Scope-Entscheidung:

- Punkt 1 ist abgeschlossen.
- Der MVP-Scope ist ab diesem Stand verbindlich eingefroren.
