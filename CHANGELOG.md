# Changelog

Alle nennenswerten Aenderungen an diesem Projekt werden in dieser Datei dokumentiert.

## [v0.9.0] - 2026-05-19

### Added
- Draggable Modals in Dashboard-, Events-, Sources-, Rules-, QuickTutorial- und SOC-Alert-Ansichten.
- Einheitliche ESC-Schliesslogik fuer Modals und Detailansichten.
- Wiederverwendbare Frontend-Hooks fuer Modal-Interaktion:
  - `useDraggableModal`
  - `useEscapeToClose`
- Neue Backend-Services und Tests fuer Event-Bus/Heuristiken.

### Changed
- Ollama-Integration robuster gemacht (Fallback auf Ports 11434/11435).
- Dashboard-Drilldown auf Zeitreihenpunkte stabilisiert (sekundengenaue Zeitfenster, provider-sicheres Detailloading).
- Docker-Setup verbessert (inkl. ollama-proxy Verhalten) und Dokumentation aktualisiert.
- Health/Feature-Flag-Verhalten fuer AI-Verfuegbarkeit verbessert.

### Fixed
- SOC-Aktivierung und AI-bezogene Fehlerpfade mit klareren API-Fehlermeldungen.
- Modal-Verhalten im UI (Dragging/Close-Interaktion) und mehrere Detailansichten ohne Daten.
