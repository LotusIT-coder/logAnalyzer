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
- 📊 Anomalieerkennung, Metriken und Pattern Scoring
- 📋 Regelbasierte Incident-Generierung und Alerting
- 💾 Persistente Quellenfilter, Kontexte und Einstellungen

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

## Technische Tiefe

Die Plattform setzt nicht nur auf KI, sondern auf eine Kombination aus klassischen und analytischen Verfahren:

- Regex- und parserbasierte Extraktion
- Event-Korrelation über Zeitfenster und Quellgruppen
- Thresholds für Burst-, Flood- und Anomalie-Erkennung
- Baselines für Normalverhalten
- Heuristics für Priorisierung und Triage
- Scoring zur Einordnung von Signalstärke und Relevanz

## Demo-Screenshots

Die README sollte idealerweise um echte Screenshots ergänzt werden. Sinnvolle Motive sind:

- Dashboard
- Detection Alerts
- Pattern Recognition
- Threat Classification
- Terminal Output

Wenn du die Screenshots später ergänzen willst, kannst du sie z. B. unter `docs/` ablegen und hier verlinken.

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
- Docker Deployment
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
│   └── pyproject.toml    # Dependencies
│
├── frontend/             # React + TypeScript
│   ├── src/
│   │   ├── pages/        # Dashboard, Events, Incidents, Rules, Sources, Upload, AIChat
│   │   ├── components/   # Reusable UI Components
│   │   ├── ctx/          # Context (State Management)
│   │   └── lib/          # API Clients
│   ├── package.json      # NPM Dependencies
│   └── vite.config.ts    # Build Config
│
├── db/                   # Database Schema (SQLite)
├── docs/                 # Dokumentation
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

## Technical Depth

The platform does not rely on AI alone. It combines classical security analytics with modern assistance:

- Regex- and parser-based extraction
- Event correlation over time windows and source groups
- Thresholds for burst, flood, and anomaly detection
- Baselines for normal behavior
- Heuristics for prioritization and triage
- Scoring to estimate signal strength and relevance

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
- Docker deployment
- Threat intelligence feeds
- IOC matching
