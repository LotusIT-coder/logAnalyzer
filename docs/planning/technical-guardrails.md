# Technische Leitplanken (Punkt 2)

Status: Frozen
Datum: 2026-05-03
Abhaengigkeiten: mvp-scope-freeze.md (Status: Frozen)
Freigabe: Produktowner bestaetigt alle 4 Stack-Entscheidungen am 2026-05-03

## 1) Ziel von Punkt 2

Festlegung der technischen Leitplanken fuer eine stabile, sichere und schnell umsetzbare MVP-Implementierung.

## 2) Festgelegter Tech-Stack (Vorschlag fuer Umsetzung)

### 2.1 Backend

- Sprache: Python 3.12
- Framework: FastAPI
- Validierung: Pydantic v2
- ASGI Server: Uvicorn
- Hintergrundjobs (MVP): FastAPI BackgroundTasks oder einfacher Worker-Prozess

Begruendung:

- Sehr gute API-Entwicklungsgeschwindigkeit mit OpenAPI-Naehe.
- Gute Eignung fuer I/O-lastige Aufgaben (Ingestion, Streaming, Ollama-Aufrufe).

### 2.2 Datenhaltung

- Datenbank: PostgreSQL 16+
- Migrationen: Alembic
- ORM/DB Layer: SQLAlchemy 2.x

### 2.3 Frontend

- Runtime: Browser (Wego-Embed + Standalone)
- Framework: React + Vite + TypeScript
- Datenabruf: REST + SSE

### 2.4 Reverse Proxy und TLS

- Proxy: Caddy oder Nginx (MVP bevorzugt Caddy wegen einfacher TLS-Automation)
- TLS: Let's Encrypt
- DynDNS: DuckDNS

### 2.5 KI

- LLM Runtime: Ollama lokal
- Modellwahl: ueber model_profile + /api/v1/ai/models

## 3) Projektstruktur (Soll-Zustand)

- backend/
- frontend/
- spec/
- db/
- docs/
- deploy/

Hinweis: spec/ und db/ sind bereits vorhanden und gelten als Contract-Quelle.

## 4) Laufzeit- und Port-Konzept

- Backend API intern: 127.0.0.1:8080
- Frontend Dev intern: 127.0.0.1:5173
- Ollama intern: 127.0.0.1:11434
- PostgreSQL intern: 127.0.0.1:5432
- Extern freigegeben: nur 443 am Reverse Proxy

Regel:

- Keine direkte externe Freigabe von API, DB oder Ollama ohne Proxy-Schutz.

## 5) Konfigurationskonzept

- Konfiguration nur ueber Umgebungsvariablen (+ optionale .env lokal)
- Geheimnisse nie im Repository
- Pflichtvariablen (MVP):
  - APP_ENV
  - DATABASE_URL
  - OLLAMA_BASE_URL
  - API_TOKEN_SIGNING_KEY
  - CORS_ALLOWED_ORIGINS
  - PUBLIC_BASE_URL

## 6) Sicherheitsbaseline (MVP verbindlich)

- Auth: Bearer Token fuer geschuetzte Endpoints
- Token-Scope-Prinzip: least privilege
- CORS: nur Wego-Domain + lokale Dev-Origin
- TLS-only im externen Zugriff
- Rate-Limits im Proxy
- Audit-Events fuer sicherheitsrelevante Aktionen
- Feldmaskierung vor Ollama fuer sensible Daten

## 7) API- und Fehlerkonvention

- OpenAPI-first Entwicklung: Endpoint wird erst implementiert, wenn im Contract vorhanden
- Einheitliches Fehlerformat (JSON):
  - code
  - message
  - details (optional)
  - trace_id

## 8) Logging und Observability

- Strukturiertes JSON-Logging im Backend
- Korrelation ueber request_id/trace_id
- Health- und readiness-Endpunkte aktiv
- Metrik-Export kann nach MVP folgen (non-goal)

## 9) Teststrategie (MVP)

- Unit-Tests fuer Parser, Rule-Engine, Maskierung
- API-Tests fuer Kernendpunkte
- Integrationsfluss:
  - file log -> event -> incident -> ai analysis -> api response

## 10) Deployment-Topologie (aktualisiert 2026-05-05)

- Zielplattform: Ubuntu-Server (On-Premises oder dedizierter Root-/VPS-Server)
- Reverse Proxy (Caddy) termininiert TLS und leitet auf lokales Backend
- Frontend: statischer Vite-Build wird vom Caddy als SPA ausgeliefert
- Backend, DB (PostgreSQL) und Ollama laufen auf demselben Server oder im lokalen Netz
- Kein Shared-Hosting, kein WebGo, kein Embed-Widget benoetigt

## 11) Bestaetigte Stack-Entscheidungen (2026-05-03)

1. FastAPI als Backend-Standard: bestaetigt.
2. React + Vite + TypeScript fuer Frontend: bestaetigt.
3. Caddy statt Nginx fuer MVP-Deploy: bestaetigt.
4. Alembic + SQLAlchemy als DB-Stack: bestaetigt.
5. Deployment-Ziel: Ubuntu On-Premises / dedizierter Server (aktualisiert 2026-05-05, WebGo entfaellt).

Punkt 2 ist abgeschlossen.
