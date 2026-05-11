# LogAnalyzer

Ein lokales, KI-gestütztes Log-Analyse-System mit FastAPI Backend und React Frontend. LogAnalyzer hilft dir, Log-Dateien zu strukturieren, automatisch zu analysieren und Anomalien zu erkennen – ohne deine Daten in die Cloud zu schicken.

**Features:**
- 📥 Log-Dateien hochladen und streamen
- 🔍 Intelligente Event-Suche und Filterung
- 🤖 KI-basierte Triage mit Ollama
- 📊 Anomalieerkennung und Metriken
- 📋 Regelbasierte Incident-Generierung
- 💾 Persistente Quellenfilter und Einstellungen

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
