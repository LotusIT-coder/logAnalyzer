ENGLISH VERSION BELOW!


# LogAnalyzer

Ein lokales, KI-gestütztes Log-Analyse-System mit FastAPI-Backend und React-Frontend. LogAnalyzer hilft dir, große Mengen heterogener Logdaten strukturiert zu analysieren, sicherheitsrelevante Muster zu erkennen und Incidents nachvollziehbar zu triagieren - ohne deine Daten in die Cloud zu schicken.

## Highlights

- Python-basiertes Detection- und Loganalyse-Framework
- MITRE-ATT&CK-orientierte Detection-Engine
- KI-gestützte Incident-Triage via Ollama
- Event-Korrelation und Anomalieerkennung
- FastAPI + React + PostgreSQL Architektur
- Fokus auf lokale Verarbeitung und Datenschutz

**Kernfunktionen:**
- 📥 Log-Dateien, Syslog und Journald-Zeilen hochladen, streamen und überwachen
- 🔍 Event-Suche, Filterung und interaktive Drilldowns
- 🤖 KI-gestützte Triage mit Ollama
- �️ **SOC Analyst**: Kontinuierlicher AI-getriebener Bedrohungsmonitor mit Heuristik-Fallback
- 📊 Anomalieerkennung, Metriken und Pattern Scoring
- 📋 Regelbasierte Incident-Generierung und Alerting
- 💾 Persistente Quellenfilter, Kontexte und Einstellungen
- 🎭 **Demo-Attack-Simulator**: Reproduzierbare MITRE-ATT&CK-Szenarien für Tests und Demos
- 🛡️ **SOC Analyst**: Continuous AI-driven threat monitor with heuristic fallback
- 🎭 **Demo Attack Simulator**: Reproducible MITRE ATT&CK scenarios for testing and demos

## Aktueller Stand (Mai 2026)

- Ollama-Fallback ist aktiv: Backend prueft und nutzt `11434` und `11435`.
- Docker-Setup enthaelt einen `ollama-proxy` (host network), damit Container den lokalen Ollama-Dienst robust erreichen.
- Dashboard-Drilldown auf Zeitreihenpunkte ist stabilisiert (sekundengenaue Zeitfenster, Postgres-Provider fuer punktgenaue Event-Details).
- Modals/Detailansichten sind verschiebbar und per `ESC` schliessbar (Dashboard, Events, Sources, Rules, Quick Tutorial).

### Docker Schnell-Update

```bash
docker-compose up -d --build
```

Wenn `docker-compose` mit `KeyError: 'ContainerConfig'` scheitert (bekannter Compose-v1-Bug), nutze stattdessen:

```bash
./scripts/compose-up-safe.sh --build
```

Das Script erkennt den Fehler und fuehrt automatisch `down --remove-orphans` + Retry aus.

Status pruefen:

```bash
docker-compose ps
```

### Binary-Log Import (allgemein)

Binaere/proprietaere Logdateien sind nicht direkt als Klartext ingestierbar.

Vorgehen:

1. Externen Decoder installieren, der das Quellformat in Text umwandelt.
2. Konvertieren + Import in einem Schritt:

```bash
BINARY_LOG_DECODER_CMD='mydecoder --to-text' ./scripts/import_binary_log.sh /pfad/zur/datei.binlog "Quelle optional"
```

Optional:

- `LOGANALYZER_API_BASE` (Default: `http://127.0.0.1:8000/api/v1`)
- `LOGANALYZER_TOKEN` fuer geschuetzte API-Endpoints

---

## Problemstellung

Sicherheitsanalysen scheitern in der Praxis oft nicht am Mangel an Daten, sondern an deren Vielfalt, Menge und Geschwindigkeit. Relevante Signale liegen verteilt in Anwendung-Logs, System-Logs, Journald, Auth-Events und Infrastruktur-Telemetrie. LogAnalyzer adressiert genau dieses Problem: Es bringt Logquellen in einen gemeinsamen Analysekontext, normalisiert sie, bewertet Muster und macht verdächtige Aktivitäten sichtbar.

## Zielsetzung

LogAnalyzer ist darauf ausgelegt, Analysten bei folgenden Aufgaben zu unterstützen:

- Erkennung verdächtiger Login-Muster
- Brute-Force-Detection
- Lateral-Movement-Indikatoren
- KI-gestützte Musteranalyse
- Unterstützung bei Incident Analysis

## Architektur

LogAnalyzer folgt einer klaren Pipeline von der Quelle bis zur Benachrichtigung:

```mermaid
flowchart TD
   A[Log Sources\nFiles, Syslog, Journald, Uploads] --> B[Parser Layer\nFormat-Erkennung & Extraktion]
   B --> C[Normalization\nCanonical Event Schema]
   C --> D[Detection Engine\nRules, Thresholds, Correlation]
   D --> E[AI / Pattern Analysis\nScoring & Triage]
   E --> F[Alerting / Dashboard\nIncidents & Investigations]
```

Die technische Umsetzung ist bewusst mehrschichtig:

- Parser für unterschiedliche Formate und Quellen
- Normalisierung in ein gemeinsames Event-Modell
- Event-Korrelation über Zeit, Quelle, Host und Service
- Schwellenwerte, Heuristiken und Baselines für verdächtige Muster
- KI-Analyse für Triage und Priorisierung

## Beispiel-Detections

Die folgenden Detection-Cases zeigen, welche Muster LogAnalyzer konkret sichtbar machen kann:

| Detection Case | Typisches Signal |
| --- | --- |
| SSH Brute Force | Viele fehlgeschlagene SSH-Logins in kurzer Zeit |
| Failed MFA Flooding | Wiederholte MFA-Abbrüche oder Push-Spam |
| Suspicious Geo Login | Ungewöhnlicher Login-Ort oder neue Region |
| Privilege Escalation Pattern | Unerwartete Sudo-/Admin-Ereignisse |
| Lateral Movement via SMB/RDP | Auffällige Verbindungen zwischen Hosts |
| API Abuse | Übermäßige Requests, Error-Spikes, ungewöhnliche Pfade |
| Impossible Travel | Zwei geografisch unplausible Logins in kurzem Abstand |
| Unusual Service Restarts | Wiederholte Restarts sicherheitskritischer Services |
| Kerberoasting Indicators | Auffällige Menge an Kerberos-Service-Ticket-Requests (z. B. Event 4769) |
| Suspicious PowerShell | Verdächtige PowerShell-Ausführung (z. B. encoded/hidden command patterns) |
| Persistence Indicators | Hinweise auf Persistenz (z. B. Scheduled Tasks, Autostart-Aktivität) |
| Service Account Abuse | Service-Account-Logins/Verwendung außerhalb normaler Muster |

## MITRE ATT&CK Mapping

Ein Mapping auf MITRE ATT&CK macht Detections für Security-Teams sofort einordbar:

| Detection | MITRE ATT&CK |
| --- | --- |
| Brute Force | T1110 |
| Lateral Movement | T1021 |
| Credential Access | T1110.001 |
| Suspicious Geo Login | T1078 |
| Privilege Escalation Pattern | T1548 |
| API Abuse | T1190 |
| Impossible Travel | T1078 |
| Unusual Service Restarts | T1569 |

## Elastic Showcase (Was Du Unbedingt Zeigen Solltest)

### 1) Event Ingestion sichtbar machen

Für Demos und Bewertung sollte klar erkennbar sein, welche Quellen in Elastic landen:

- Filebeat
- Winlogbeat
- Syslog
- Elastic Agent

Empfehlung fuer den Demo-Fluss:

1. Quelle erzeugt Event
2. Event landet im LogAnalyzer (PostgreSQL + Outbox)
3. Outbox-Indexer schreibt nach Elasticsearch
4. Event ist in Elasticsearch (und optional Kibana) sichtbar

Deterministischer One-Command-Seed fuer Demo-Daten (filebeat, winlogbeat, syslog, elastic_agent):

```bash
./scripts/demo-seed-elastic-sources.sh
```

Voraussetzung: Backend-API laeuft auf `http://localhost:8000` (oder `LOGANALYZER_API_BASE` setzen).

Optional mit Auth-Token oder anderem API-Endpoint:

```bash
LOGANALYZER_TOKEN=<token> LOGANALYZER_API_BASE=http://localhost:8000/api/v1 ./scripts/demo-seed-elastic-sources.sh
```

### 2) Detection Correlation zeigen (sehr wichtig)

Nicht nur Einzel-Events, sondern Ketten und Sequenzen zeigen:

- Multiple failed logins
- Geo anomalies
- Privilege escalation sequence
- Suspicious PowerShell chain

### 3) Kibana/Dashboard Integration mit Screenshots

Das bringt in Reviews einen starken Pluspunkt. Empfohlene Bildserie:

1. Discover-Ansicht mit gefilterten Security-Events
2. Dashboard mit Zeitreihe + Top Hosts/Services
3. Drilldown von Dashboard zu konkreten Event-Dokumenten

Optional bereitgestellt (Sprint C-01):

- Saved Objects Export: `docs/kibana/loganalyzer-security-demo.ndjson`
- Import-Anleitung: `docs/operations/kibana-saved-objects.md`

Optional bereitgestellt (Sprint C-02/C-03):

- Incident -> Kibana Discover Deep-Link in der Incidents-Ansicht (aktivierbar via `VITE_KIBANA_BASE_URL` oder `localStorage['kibana.baseUrl']`)
- Screenshot-Runbook: `docs/operations/kibana-demo-screenshots.md`

### 4) MITRE Mapping als Kette darstellen

Besonders stark ist die direkte Kette:

Elastic Event -> Detection Rule -> MITRE Technique

Beispielhafte Mapping-Ketten:

| Elastic Event Pattern | Detection Rule | MITRE Technique |
| --- | --- | --- |
| Repeated auth failure (`event.code:4625`) | Multiple failed logins | T1110 (Brute Force) |
| Login from unusual country/ASN | Geo anomaly login rule | T1078 (Valid Accounts) |
| New admin group membership + sudo activity | Privilege escalation sequence | T1548 (Abuse Elevation Control Mechanism) |
| Encoded/hidden PowerShell command chain | Suspicious PowerShell chain | T1059.001 (PowerShell) |

## Technische Tiefe

Die Plattform setzt nicht nur auf KI, sondern auf eine Kombination aus klassischen und analytischen Verfahren:

- Regex- und parserbasierte Extraktion
- Multi-Pattern-Matching fuer verdaechtige Befehls- und Authentifizierungsindikatoren
- Event-Korrelation über Zeitfenster und Quellgruppen
- Thresholds für Burst-, Flood- und Anomalie-Erkennung
- Baselines für Normalverhalten
- Heuristics für Priorisierung und Triage
- Scoring zur Einordnung von Signalstärke und Relevanz

## Example Investigation Workflow

1. SSH- und VPN-Logs ingestieren
2. Events normalisieren
3. Fehlgeschlagene Logins korrelieren
4. Verdächtige Zugriffsmuster erkennen
5. Incidents generieren
6. Incidents mit KI-gestütztem Scoring priorisieren
7. Korrelierte Belege im Dashboard prüfen

## Security & Privacy

- Lokale Verarbeitung der Daten
- Kein Cloud-Zwang
- Datenschutzorientierte Architektur
- Offline-freundlich nutzbar
- Air-gap-nah einsetzbar

## Demo-Screenshots

Die wichtigsten Ansichten aus der laufenden Anwendung im kompakten Überblick:

<table>
   <tr>
      <td align="center"><img src="docs/screenshots/dashboard.png" alt="Dashboard" width="260"><br><strong>Dashboard</strong></td>
      <td align="center"><img src="docs/screenshots/events.png" alt="Events" width="260"><br><strong>Events</strong></td>
   </tr>
   <tr>
      <td align="center"><img src="docs/screenshots/incidents.png" alt="Incidents" width="260"><br><strong>Incidents</strong></td>
      <td align="center"><img src="docs/screenshots/ai-chat.png" alt="AI Chat" width="260"><br><strong>AI Chat</strong></td>
   </tr>
   <tr>
      <td align="center"><img src="docs/screenshots/sources.png" alt="Sources" width="260"><br><strong>Sources</strong></td>
      <td></td>
   </tr>
</table>

## Beispiel-Logs

### Benign

```text
2026-05-14T10:14:21Z auth.service login successful user=alice host=workstation-01 ip=10.10.1.20
2026-05-14T10:14:23Z app-api request ok method=GET path=/health status=200 latency_ms=12
```

### Malicious

```text
2026-05-14T10:16:02Z sshd authentication failure user=root host=server-03 ip=203.0.113.42
2026-05-14T10:16:04Z sshd authentication failure user=root host=server-03 ip=203.0.113.42
2026-05-14T10:16:06Z sshd authentication failure user=root host=server-03 ip=203.0.113.42
```

### Mixed Traffic

```text
2026-05-14T10:18:11Z vpn login success user=bob region=DE
2026-05-14T10:18:19Z vpn login failure user=bob region=US
2026-05-14T10:18:25Z rdp connection from host=ws-17 to host=dc-02
```

## Roadmap

- Sigma Rule Support
- Wazuh Integration
- Syslog Collector
- Helm/Kubernetes-Deployment
- Threat Intelligence Feeds
- IOC Matching

---

## Systemanforderungen

### Für den Server (Backend)
- **Python** 3.12 oder höher
- **PostgreSQL** 12+ (oder SQLite für Entwicklung)
- **Ollama** (für AI-Features; optional, aber empfohlen)
- **Linux/macOS/WSL2** (Windows-Support begrenzt)

### Für den Client (Frontend)
- **Node.js** 18+ oder **npm** 9+
- Moderner Browser (Chrome, Firefox, Safari, Edge)

---

## Installation

### 1. Repository klonen und Verzeichnis wechseln

```bash
git clone <repo-url>
cd logAnalyzer
```

### 2. Backend einrichten

#### 2.1 Python Virtual Environment erstellen

```bash
cd backend
python3.12 -m venv .venv
source .venv/bin/activate   # Linux/macOS
# Oder unter Windows:
# .venv\Scripts\activate
```

#### 2.2 Python-Abhängigkeiten installieren

```bash
pip install --upgrade pip
pip install -e ".[dev]"
```

Dies installiert:
- FastAPI und Uvicorn (Web-Framework)
- SQLAlchemy und asyncpg (Datenbankzugriff)
- Alembic (Migrations)
- Pytest und pytest-asyncio (Test-Tools)

#### 2.3 Datenbankverbindung konfigurieren

Erstelle oder bearbeite die `.env`-Datei im `backend/`-Verzeichnis:

```bash
# Für PostgreSQL
DATABASE_URL=postgresql+asyncpg://user:password@localhost:5432/loganalyzer_db

# Oder für SQLite (nur Entwicklung!)
DATABASE_URL=sqlite+aiosqlite:///./loganalyzer.db
```

Falls PostgreSQL verwendet wird, Datenbank erstellen:

```bash
createdb loganalyzer_db
```

#### 2.4 Datenbank-Migrationen ausführen

```bash
alembic upgrade head
```

#### 2.5 Backend starten

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Der Backend läuft dann unter `http://localhost:8000`.  
API-Dokumentation ist verfügbar unter `http://localhost:8000/docs` (Swagger UI).

---

### 3. Frontend einrichten

#### 3.1 Dependencies installieren

Öffne ein **neues Terminal**-Fenster und navigiere zum Frontend:

```bash
cd frontend
npm install
```

#### 3.2 Development-Server starten

```bash
npm run dev
```

Der Frontend läuft dann unter `http://localhost:5173`.

#### 3.3 (Optional) Frontend für Production bauen

```bash
npm run build
npm run preview
```

---

### 4. Ollama einrichten (für AI-Features)

Falls du die KI-Features (Triage, Anomalieerkennung) nutzen möchtest:

1. **Ollama installieren**: https://ollama.ai
2. **Ollama starten**: `ollama serve`
3. **Modell herunterladenfallend noch nicht vorhanden**:
   ```bash
   ollama pull mistral
   ```
4. **Backend-Config anpassen** (falls nötig):
   - Standard: `http://localhost:11434` (Ollama-API)
   - In `backend/app/config.py` oder `.env` anpassen

---

## Verwendung & UI-Erklärung

### 🏠 Dashboard
- **Zentrale Übersicht** aller Events und Incidents
- **Quellenfilter**: Wähle Log-Dateien aus, deren Events angezeigt werden sollen
- **Zeitraum-Auswahl**: Filtere nach letzten X Stunden
- **Top Errors**: Automatisch aufgelistete häufigste Fehler
- **Ingestion**: Starte manuell die Log-Verarbeitung für ausgewählte Quellen

### 📋 Sources (Log-Quellen)
- **Quellen verwalten**: Konfiguriere, wo deine Log-Dateien sind
- **Preset-Quellen**: Vordefinierte Standard-Log-Pfade
- **Custom Sources**: Eigene Pfade hochladen
- **Live-View**: Stream neue Log-Zeilen direkt vom Server (Tail-Modus)

### 🔍 Events
- **Gefilterte Event-Liste**: Nach Quelle, Zeit, Severity, Host, Service, Suchtext
- **Multi-Select Severity**: Wähle mehrere Schweregrade auf einmal
- **Quelle aus Dashboard übernehmen**: Automatische Synchronisation
- **Pagination**: Blättere durch Events mit Cursor-basiertem Pagination
- **Live-Refresh**: Aktualisiere die Eventliste jederzeit manuell

### ⚠️ Incidents
- **Automatisch generierte Incidents**: Aus Regeln oder KI-Triage
- **Status-Management**: Markiere Incidents als archiviert/gelöst
- **Zugehörige Events**: Siehe, welche Events zu einem Incident gehören

### 🎯 Rules
- **Regelbasierte Incident-Generierung**: Definiere Muster für automatische Incidents
- **Scheduling**: Regeln können zeitgesteuert laufen

### 🤖 AI Chat
- **Interaktive KI-Analyse**: Stelle Fragen zu deinen Logs
- **Kontext**: Die KI hat Zugriff auf ausgewählte Events
- **Ollama-Integration**: Nutzt lokale LLM für Datenschutz

### 📤 Upload
- **Log-Dateien hochladen**: Importiere große Dateien direkt
- **Progress-Feedback**: Siehe Upload- und Parse-Fortschritt in Echtzeit

---

## Troubleshooting

### Backend startet nicht / Port 8000 belegt

```bash
# Prozess auf Port 8000 finden
lsof -i :8000

# Prozess beenden (PID ersetzen)
kill -9 <PID>

# Oder auf anderen Port ausweichen
uvicorn app.main:app --reload --host 127.0.0.1 --port 8001
```

### Datenbank-Fehler: "asyncpg.exceptions.InvalidPasswordError"

- **Ursache**: PostgreSQL-Credentials falsch oder Benutzer existiert nicht
- **Lösung**: Credentials in `.env` (DATABASE_URL) überprüfen
  ```bash
  psql -U postgres -h localhost
  CREATE USER loganalyzer WITH PASSWORD 'your_password';
  CREATE DATABASE loganalyzer_db OWNER loganalyzer;
  ```

### Alembic-Migration schlägt fehl

```bash
# Aktuellen Status prüfen
alembic current

# Auf eine spezifische Version zurücksetzen (falls nötig)
alembic downgrade base

# Neu migrieren
alembic upgrade head
```

### Frontend lädt nicht / zeigt nur weiße Seite

1. **Browser-Console prüfen**: F12 → Console-Tab
2. **Backend läuft?** Check `http://localhost:8000/docs`
3. **CORS-Fehler?** Backend muss Frontend-Origin erlauben:
   ```python
   # app/main.py
   app.add_middleware(
       CORSMiddleware,
       allow_origins=["http://localhost:5173"],
       allow_credentials=True,
       allow_methods=["*"],
       allow_headers=["*"],
   )
   ```

### Logs werden nicht verarbeitet

- **Dateipfad prüfen**: Existiert die Datei und hat der Prozess Lesezugriff?
  ```bash
  ls -la /path/to/logfile
  ```
- **Source konfiguriert?** Gehe zu Sources-Seite und überprüfe den Pfad
- **Ingestion starten**: Klick auf Dashboard → "Verarbeitung starten"
- **Watcher zu langsam?** Der Watcher pollt im Leerlauf alle `WATCHER_INTERVAL_SECONDS`
  (Default `0.5 s`) und schaltet bei vorhandenem Backlog in einen Catch-up-Modus mit
  `WATCHER_CATCHUP_MIN_SLEEP_SECONDS` zwischen Ticks (Default `0.02 s`). Beide Werte
  lassen sich per Env-Variable überschreiben, z. B.:
  ```bash
  WATCHER_INTERVAL_SECONDS=1.0 WATCHER_CATCHUP_MIN_SLEEP_SECONDS=0.05 ./scripts/dev-up.sh
  ```

### AI/Ollama antwortet nicht

1. **Ollama läuft?**
   ```bash
   curl http://localhost:11434/api/tags
   ```
2. **Modell installiert?**
   ```bash
   ollama pull mistral
   ```
3. **Backend-Config prüfen**: `OLLAMA_BASE_URL` in `.env` oder `app/config.py`

### Performance: Backend lädt langsam

- **Datenbank-Indizes**: Migrationen bereits ausgeführt? (`alembic current`)
- **Log-Größe**: Sehr große Log-Dateien verarbeiten länger
- **Ressourcen**: RAM/CPU ausreichend?
  ```bash
  free -h
  top
  ```

### Tests lokal ausführen

```bash
cd backend
pytest -v tests/
# Oder mit Coverage
pytest --cov=app tests/
```

---

## Deployment

### Mit systemd User Services (Empfohlen)

```bash
# Services installieren
./scripts/install-user-services.sh

# Status prüfen
systemctl --user status loganalyzer-dev.target

# Logs anschauen
journalctl --user -u loganalyzer-backend.service -f
journalctl --user -u loganalyzer-frontend.service -f
```

### Mit Skripten (Manuell)

Für das lokale One-Command-Setup reicht in der Regel `./scripts/dev-up.sh`.

```bash
# Alles starten
./scripts/dev-up.sh

# Status prüfen
./scripts/dev-status.sh

# Alles stoppen
./scripts/dev-down.sh

# Diagnostik
./scripts/diag-instance.sh
```

### Docker / Compose

Container-Setup mit One-Command-Start:

```bash
docker compose up --build -d
```

Optional mit Elasticsearch-Profil (sekundaerer Search/Analytics-Store):

```bash
ELASTIC_ENABLED=true docker compose --profile elastic up --build -d
```

Mit Outbox-Indexer aktiv (PR2, empfohlen fuer kontinuierliches Indexing):

```bash
ELASTIC_ENABLED=true ELASTIC_INDEXER_ENABLED=true docker compose --profile elastic up --build -d
```

Nützliche Befehle:

```bash
# Logs ansehen
docker compose logs -f

# Services stoppen
docker compose down

# Services + Datenbank-Volume entfernen
docker compose down -v
```

Standard-URLs im Compose-Setup:

- Frontend: `http://localhost:8080`
- Backend API: `http://localhost:8000`
- Elasticsearch (optional Profil): `http://localhost:9200`

Hinweis zu Ollama: Wenn Ollama lokal auf dem Host läuft, nutzt das Backend im Compose-Setup `http://host.docker.internal:11434`.
Hinweis zu Health: `GET /api/v1/health` liefert zusätzlich `elastic_enabled`, `elastic_available`, `elastic_bootstrap_ok` und `elastic_indexer_running`.

Event-Search-Routing (PR3):

- Standard (`provider=auto`): bevorzugt Elasticsearch und faellt bei Fehlern auf PostgreSQL zurueck
- Diagnose erzwingen: `GET /api/v1/events?provider=postgres` oder `GET /api/v1/events?provider=elastic`
- Der verwendete Provider wird im Response-Header `X-Events-Provider` ausgegeben

Historische Events in die Outbox nachschieben (Backfill):

```bash
cd backend
source .venv/bin/activate
python -m app.services.elastic_backfill --batch-size 1000
```

### Maintainer-Checkliste (README + Docker aktuell halten)

Bei jeder funktionalen Aenderung mit Build-, Runtime- oder API-Auswirkung:

- README aktualisieren (Features, Setup, Ports, Healthchecks, bekannte Grenzen)
- Docker-Artefakte pruefen und bei Bedarf anpassen (`docker-compose.yml`, `backend/Dockerfile`, `frontend/Dockerfile`, `frontend/nginx.conf`)
- Einmal verifizieren: `docker compose up --build -d` und Healthcheck auf `http://localhost:8000/api/v1/health`
- Frontend-Proxy pruefen: `http://localhost:8080/api/v1/health`
- Runbook konsistent halten: `docs/operations/local-runtime.md` bei geaenderten Betriebsablaeufen mitziehen

---

## Projektstruktur

```
logAnalyzer/
├── backend/              # FastAPI Server
│   ├── app/
│   │   ├── api/          # API Endpoints (v1)
│   │   ├── db/           # Database & Session
│   │   ├── domain/       # Models
│   │   ├── ingestion/    # Log-Einlesung
│   │   ├── parser/       # Log-Parsing
│   │   ├── ai/           # Ollama Integration
│   │   └── services/     # Business Logic
│   ├── alembic/          # Database Migrations
│   ├── tests/            # Unit & Integration Tests
│   ├── Dockerfile        # Backend container image
│   └── pyproject.toml    # Dependencies
│
├── frontend/             # React + TypeScript
│   ├── src/
│   │   ├── pages/        # Dashboard, Events, Incidents, Rules, Sources, Upload, AIChat
│   │   ├── components/   # Reusable UI Components
│   │   ├── ctx/          # Context (State Management)
│   │   └── lib/          # API Clients
│   ├── Dockerfile        # Frontend container image
│   ├── package.json      # NPM Dependencies
│   └── vite.config.ts    # Build Config
│
├── db/                   # Database Schema (SQLite)
├── docs/                 # Dokumentation
├── docker-compose.yml    # Docker/Compose One-Command Setup
├── scripts/              # Start/Stop Scripts
└── spec/                 # OpenAPI Spec
```

---

## Lizenz & Support

Entwickelt und gepflegt von **LotusIT**.

Für Fragen oder Bug-Reports: GitHub Issues oder intern kontaktieren.

---

## Schnellstart-Checkliste

- [ ] Python 3.12+ installiert
- [ ] Node.js 18+ installiert
- [ ] Repository geklont
- [ ] Backend Virtual Environment erstellt
- [ ] Backend-Dependencies installiert (`pip install -e ".[dev]"`)
- [ ] Datenbank konfiguriert (`.env`)
- [ ] Migrationen ausgeführt (`alembic upgrade head`)
- [ ] Backend gestartet (`uvicorn app.main:app --reload`)
- [ ] Frontend-Dependencies installiert (`npm install`)
- [ ] Frontend gestartet (`npm run dev`)
- [ ] Dashboard zugänglich unter `http://localhost:5173`
- [ ] Erste Log-Quelle hinzugefügt (Sources-Seite)
- [ ] (Optional) Ollama installiert und konfiguriert

--------------------------------------------------------------------------------------------------------------

# LogAnalyzer

An AI-assisted log analysis and detection framework with a FastAPI backend and a React frontend. LogAnalyzer helps you analyze large volumes of heterogeneous log data, detect security-relevant patterns, and triage incidents locally without sending data to the cloud.

## Highlights

- Python-based detection and log analysis framework
- MITRE ATT&CK-oriented detection engine
- AI-assisted incident triage via Ollama
- Event correlation and anomaly detection
- **SOC Analyst**: Continuous AI-driven threat monitor with heuristic fallback
- **Demo Attack Simulator**: Reproducible MITRE ATT&CK scenarios for testing and demos
- FastAPI + React + PostgreSQL architecture
- Local processing with privacy-first design

## Problem Statement

Security analysis is rarely limited by the lack of logs. The real challenge is the volume, variety, and velocity of the data. Relevant signals are distributed across application logs, system logs, journald, authentication events, and infrastructure telemetry. LogAnalyzer addresses this by bringing log sources into a unified analysis context, normalizing them, evaluating patterns, and surfacing suspicious activity.

## Goals

LogAnalyzer is designed to support analysts in tasks such as:

- Detecting suspicious login patterns
- Brute-force detection
- Lateral movement indicators
- AI-assisted pattern analysis
- Supporting incident investigations

## Architecture

LogAnalyzer follows a clear pipeline from source to alerting:

```mermaid
flowchart TD
   A[Log Sources\nFiles, Syslog, Journald, Uploads] --> B[Parser Layer\nFormat Detection & Extraction]
   B --> C[Normalization\nCanonical Event Schema]
   C --> D[Detection Engine\nRules, Thresholds, Correlation]
   D --> E[AI / Pattern Analysis\nScoring & Triage]
   E --> F[Alerting / Dashboard\nIncidents & Investigations]
```

Technical building blocks:

- Parsers for different formats and sources
- Normalization into a shared event model
- Event correlation across time, source, host, and service
- Thresholds, heuristics, and baselines for suspicious behavior
- AI analysis for triage and prioritization

## Example Detections

These example detections show what LogAnalyzer can surface in practice:

| Detection Case | Typical Signal |
| --- | --- |
| SSH Brute Force | Many failed SSH logins in a short time |
| Failed MFA Flooding | Repeated MFA failures or push spam |
| Suspicious Geo Login | Unusual login location or new region |
| Privilege Escalation Pattern | Unexpected sudo/admin activity |
| Lateral Movement via SMB/RDP | Suspicious connections between hosts |
| API Abuse | High request volume, error spikes, unusual paths |
| Impossible Travel | Two geographically implausible logins close together |
| Unusual Service Restarts | Repeated restarts of critical services |
| Kerberoasting Indicators | Bursts of Kerberos service ticket requests (for example Event 4769) |
| Suspicious PowerShell | Suspicious PowerShell execution (for example encoded/hidden command patterns) |
| Persistence Indicators | Persistence-related activity (for example scheduled tasks, autostart behavior) |
| Service Account Abuse | Service account usage or logins outside expected behavior |

## SOC Analyst – Continuous AI Monitor

The SOC Analyst runs as a dedicated background service and automatically evaluates incoming events for threat patterns – no manual triggering required.

### How it works

1. **Event fetch**: Every `SOC_ANALYST_INTERVAL_SECONDS` the service loads the most recent N events, sorted by severity (critical → error → warning → info) so high-signal events always fill the analysis window first
2. **LLM analysis**: Ollama evaluates the batch for threat patterns and returns a structured JSON finding
3. **Heuristic fallback**: Deterministically detects clear signal patterns (e.g. ≥5 failed SSH logins, large outbound flows) even when the LLM responds conservatively
4. **Deduplication**: The same pattern within an open incident does not trigger a new alert
5. **Incident creation**: When confidence ≥ threshold, an `ai_soc` incident is created and queued for auto-triage

### Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `SOC_ANALYST_ENABLED` | `true` | Enable service on startup |
| `SOC_ANALYST_MODEL` | `llama3` | Ollama model to use |
| `SOC_ANALYST_INTERVAL_SECONDS` | `20` | Seconds between analysis ticks |
| `SOC_ANALYST_CONFIDENCE_THRESHOLD` | `0.3` | Minimum confidence to create an incident |
| `SOC_ANALYST_WINDOW_EVENTS` | `100` | Events per analysis batch |

The service can be controlled at runtime via API:

```bash
# Query current status
curl http://localhost:8000/api/v1/system/soc-analyst

# Restrict to specific sources
curl -X PUT http://localhost:8000/api/v1/system/soc-analyst \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true, "source_ids": ["<uuid>", "<uuid>"]}'

# Monitor all sources
curl -X PUT http://localhost:8000/api/v1/system/soc-analyst \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true, "source_ids": []}'
```

## Demo Attack Simulator

Generates reproducible MITRE ATT&CK attack scenario log files and registers the corresponding sources via API:

```bash
python3 scripts/demo_attack_simulation.py
```

Included scenarios:

| Scenario | MITRE | Type |
| --- | --- | --- |
| SSH Brute Force + Post-Exploitation | T1110 | syslog |
| Linux Privilege Escalation (sudo/SUID) | T1548 | syslog |
| Obfuscated PowerShell + Recon | T1059.001 + T1027 | filebeat |
| Kerberoasting (TGS burst) | T1558.003 | winlogbeat |
| SQL Injection Probing | T1190 | file |
| Port Scan (UFW BLOCK) | T1046 | syslog |
| Data Exfiltration (large outbound flows) | T1041 | file |
| Ransomware (shadow copy deletion + mass rename) | T1486 | elastic_agent |
| Baseline noise (benign traffic) | – | file |

Each run **appends** to existing files so the ingestion watcher reliably detects new bytes. Detection rules are created automatically; use `--skip-rules` to skip.

## MITRE ATT&CK Mapping

| Detection | MITRE ATT&CK |
| --- | --- |
| Brute Force | T1110 |
| Lateral Movement | T1021 |
| Credential Access | T1110.001 |
| Suspicious Geo Login | T1078 |
| Privilege Escalation Pattern | T1548 |
| API Abuse | T1190 |
| Impossible Travel | T1078 |
| Unusual Service Restarts | T1569 |

## Elastic Showcase (What You Should Definitely Present)

### 1) Event ingestion visibility

For demos and evaluations, clearly show which sources end up in Elastic:

- Filebeat
- Winlogbeat
- Syslog
- Elastic Agent

Recommended demo flow:

1. Source emits an event
2. Event is persisted in LogAnalyzer (PostgreSQL + outbox)
3. Outbox indexer writes to Elasticsearch
4. Event is visible in Elasticsearch (and optionally Kibana)

Deterministic one-command demo seed for filebeat, winlogbeat, syslog, and elastic_agent:

```bash
./scripts/demo-seed-elastic-sources.sh
```

Prerequisite: backend API is running on `http://localhost:8000` (or set `LOGANALYZER_API_BASE`).

Optional with auth token or custom API endpoint:

```bash
LOGANALYZER_TOKEN=<token> LOGANALYZER_API_BASE=http://localhost:8000/api/v1 ./scripts/demo-seed-elastic-sources.sh
```

### 2) Detection correlation (critical)

Show chains and sequences, not only single events:

- Multiple failed logins
- Geo anomalies
- Privilege escalation sequence
- Suspicious PowerShell chain

### 3) Kibana/dashboard integration with screenshots

This is a major plus in technical reviews. Recommended screenshot set:

1. Discover view with filtered security events
2. Dashboard with time series + top hosts/services
3. Drilldown from dashboard to concrete event documents

### 4) MITRE mapping as an end-to-end chain

The strongest framing is the direct chain:

Elastic Event -> Detection Rule -> MITRE Technique

Example mapping chains:

| Elastic Event Pattern | Detection Rule | MITRE Technique |
| --- | --- | --- |
| Repeated auth failure (`event.code:4625`) | Multiple failed logins | T1110 (Brute Force) |
| Login from unusual country/ASN | Geo anomaly login rule | T1078 (Valid Accounts) |
| New admin group membership + sudo activity | Privilege escalation sequence | T1548 (Abuse Elevation Control Mechanism) |
| Encoded/hidden PowerShell command chain | Suspicious PowerShell chain | T1059.001 (PowerShell) |

## Technical Depth

The platform does not rely on AI alone. It combines classical security analytics with modern assistance:

- Regex- and parser-based extraction
- Multi-pattern matching for suspicious command and authentication indicators
- Event correlation over time windows and source groups
- Thresholds for burst, flood, and anomaly detection
- Baselines for normal behavior
- Heuristics for prioritization and triage
- Scoring to estimate signal strength and relevance

## Example Investigation Workflow

1. Ingest SSH and VPN logs
2. Normalize events
3. Correlate failed logins
4. Detect suspicious access patterns
5. Generate incidents
6. Prioritize incidents using AI-assisted scoring
7. Review correlated evidence in the dashboard

## Security & Privacy

- Local data processing
- No cloud dependency
- Privacy-first architecture
- Offline-friendly operation
- Suitable for air-gap-adjacent environments

## Deployment

For a local one-command setup, the current workflow is already automated with:

```bash
./scripts/dev-up.sh
```

Docker / Compose one-command setup:

```bash
docker compose up --build -d
```

Optional with Elasticsearch profile (secondary search/analytics store):

```bash
ELASTIC_ENABLED=true docker compose --profile elastic up --build -d
```

With outbox indexer enabled (PR2, recommended for continuous indexing):

```bash
ELASTIC_ENABLED=true ELASTIC_INDEXER_ENABLED=true docker compose --profile elastic up --build -d
```

Useful commands:

```bash
# Tail logs
docker compose logs -f

# Stop services
docker compose down

# Stop services and remove database volume
docker compose down -v
```

Default URLs in the Compose setup:

- Frontend: `http://localhost:8080`
- Backend API: `http://localhost:8000`
- Elasticsearch (optional profile): `http://localhost:9200`

Ollama note: If Ollama runs on the host machine, the backend uses `http://host.docker.internal:11434` in Compose.
Health note: `GET /api/v1/health` now also returns `elastic_enabled`, `elastic_available`, `elastic_bootstrap_ok`, and `elastic_indexer_running`.

Event search routing (PR3):

- Default (`provider=auto`): prefers Elasticsearch and falls back to PostgreSQL on failures
- Force for diagnostics: `GET /api/v1/events?provider=postgres` or `GET /api/v1/events?provider=elastic`
- The provider used is returned in response header `X-Events-Provider`

Backfill historical events into the outbox:

```bash
cd backend
source .venv/bin/activate
python -m app.services.elastic_backfill --batch-size 1000
```

## Maintainer Checklist (Keep README + Docker in Sync)

For every functional change that impacts build, runtime, or API behavior:

- Update README (features, setup, ports, health checks, known limitations)
- Verify and adjust Docker artifacts when needed (`docker-compose.yml`, `backend/Dockerfile`, `frontend/Dockerfile`, `frontend/nginx.conf`)
- Verify once with `docker compose up --build -d` and a health check on `http://localhost:8000/api/v1/health`
- Verify frontend proxy on `http://localhost:8080/api/v1/health`
- Keep the runbook aligned by updating `docs/operations/local-runtime.md` when operational flows change

## Demo Screenshots

Key views from the running application in a compact gallery:

<table>
   <tr>
      <td align="center"><img src="docs/screenshots/dashboard.png" alt="Dashboard" width="260"><br><strong>Dashboard</strong></td>
      <td align="center"><img src="docs/screenshots/events.png" alt="Events" width="260"><br><strong>Events</strong></td>
   </tr>
   <tr>
      <td align="center"><img src="docs/screenshots/incidents.png" alt="Incidents" width="260"><br><strong>Incidents</strong></td>
      <td align="center"><img src="docs/screenshots/ai-chat.png" alt="AI Chat" width="260"><br><strong>AI Chat</strong></td>
   </tr>
   <tr>
      <td align="center"><img src="docs/screenshots/sources.png" alt="Sources" width="260"><br><strong>Sources</strong></td>
      <td></td>
   </tr>
</table>

## Demo Data

### Benign

```text
2026-05-14T10:14:21Z auth.service login successful user=alice host=workstation-01 ip=10.10.1.20
2026-05-14T10:14:23Z app-api request ok method=GET path=/health status=200 latency_ms=12
```

### Malicious

```text
2026-05-14T10:16:02Z sshd authentication failure user=root host=server-03 ip=203.0.113.42
2026-05-14T10:16:04Z sshd authentication failure user=root host=server-03 ip=203.0.113.42
2026-05-14T10:16:06Z sshd authentication failure user=root host=server-03 ip=203.0.113.42
```

### Mixed Traffic

```text
2026-05-14T10:18:11Z vpn login success user=bob region=DE
2026-05-14T10:18:19Z vpn login failure user=bob region=US
2026-05-14T10:18:25Z rdp connection from host=ws-17 to host=dc-02
```

## Roadmap

- Sigma rule support
- Wazuh integration
- Syslog collector
- Helm/Kubernetes deployment
- Threat intelligence feeds
- IOC matching
