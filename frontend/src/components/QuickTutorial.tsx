import { useState } from 'react'

const TOUR_STORAGE_KEY = 'lotus-analyzer-onboarding-v1'

const STEPS = [
  {
    title: '1. Datenbestand eingrenzen',
    body: 'Starte im Dashboard. Dort legst du Quellen und Zeitfenster fest, auf denen die Kennzahlen und spaeteren Drilldowns basieren.',
    focus: 'Dashboard',
  },
  {
    title: '2. Auffaelligkeiten finden',
    body: 'Pruefe danach Events und Incidents. Filter, Status und Kontextchips helfen dir, eine Stoerung von der groben Suche bis zum Einzelereignis einzukreisen.',
    focus: 'Events und Incidents',
  },
  {
    title: '3. Netzwerkfluss lesen',
    body: 'Im Netzwerktab kombinierst du Knoten, Verbindungen, Volumen und jetzt auch Geolokation. KPI-Karten, Knoten und Pfade sind direkt aufschluesselbar.',
    focus: 'Netzwerk',
  },
  {
    title: '4. Regeln und Quellen pflegen',
    body: 'In Quellen und Regeln pruefst du, welche Daten hereinkommen und wann automatisch ein Incident entsteht. Tests, Live-Ansichten und Statuswechsel greifen dort ineinander.',
    focus: 'Quellen und Regeln',
  },
  {
    title: '5. AI mit Kontext nutzen',
    body: 'Nutze "Im AI Chat analysieren", wenn du eine aktuelle Auswahl oder einen Netzwerkfokus direkt an den Chat uebergeben willst. Der naechste Prompt baut darauf auf.',
    focus: 'AI Chat',
  },
  {
    title: '6. Kontext-Hilfe nutzen',
    body: 'Die i-Elemente sind absichtlich dezent gehalten. Nutze sie bei Filtern, Tabellen und Statusanzeigen, wenn du an einer Stelle mehr Kontext brauchst.',
    focus: 'Hilfe im UI',
  },
]

export default function QuickTutorial() {
  const [welcomeOpen, setWelcomeOpen] = useState(() => {
    if (typeof window === 'undefined') return false
    try {
      return !window.localStorage.getItem(TOUR_STORAGE_KEY)
    } catch {
      return false
    }
  })
  const [open, setOpen] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)

  function markSeen() {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(TOUR_STORAGE_KEY, 'seen')
    } catch {
      // Ignore storage access issues and keep the tour usable manually.
    }
  }

  function startTour(fromStep = 0) {
    setStepIndex(fromStep)
    setWelcomeOpen(false)
    setOpen(true)
    markSeen()
  }

  function closeTour() {
    setOpen(false)
    markSeen()
  }

  function dismissWelcome() {
    setWelcomeOpen(false)
    markSeen()
  }

  const activeStep = STEPS[stepIndex]
  const isFirstStep = stepIndex === 0
  const isLastStep = stepIndex === STEPS.length - 1

  return (
    <div style={styles.root}>
      <button type="button" onClick={() => startTour(0)} style={styles.trigger}>
        Schnell-Tour
      </button>
      {welcomeOpen && (
        <div style={styles.welcomeCard}>
          <div style={styles.welcomeEyebrow}>Erstbesuch</div>
          <div style={styles.welcomeTitle}>Kurz durch den LotusAnalyzer fuehren lassen?</div>
          <div style={styles.welcomeBody}>
            Die Tour erklaert in wenigen Schritten, wie Quellen, Events, Netzwerk, Regeln und AI zusammenarbeiten.
          </div>
          <div style={styles.welcomeActions}>
            <button type="button" onClick={() => startTour(0)} style={styles.primaryBtn}>Tour starten</button>
            <button type="button" onClick={dismissWelcome} style={styles.secondaryBtn}>Spaeter</button>
          </div>
        </div>
      )}
      {open && (
        <div style={styles.overlay} role="dialog" aria-modal="true" aria-label="Schnell-Tutorial">
          <div style={styles.modal}>
            <div style={styles.header}>
              <div>
                <div style={styles.eyebrow}>LotusAnalyzer</div>
                <h3 style={styles.title}>Gefuehrter Einstieg</h3>
              </div>
              <button type="button" onClick={closeTour} style={styles.closeBtn}>Schliessen</button>
            </div>
            <div style={styles.progressRow}>
              <div style={styles.progressText}>Schritt {stepIndex + 1} von {STEPS.length}</div>
              <div style={styles.progressDots}>
                {STEPS.map((step, index) => (
                  <button
                    key={step.title}
                    type="button"
                    onClick={() => setStepIndex(index)}
                    aria-label={`Zu ${step.title} wechseln`}
                    style={{
                      ...styles.progressDot,
                      ...(index === stepIndex ? styles.progressDotActive : null),
                    }}
                  />
                ))}
              </div>
            </div>
            <div style={styles.card}>
              <div style={styles.cardFocus}>{activeStep.focus}</div>
              <div style={styles.cardTitle}>{activeStep.title}</div>
              <div style={styles.cardBody}>{activeStep.body}</div>
            </div>
            <div style={styles.hintBand}>
              Waehrend der Tour findest du die dezenten i-Elemente neben Filtern, Tabellen und Statusangaben. Dort steckt die kontextnahe Erklaerung ohne Seitenwechsel.
            </div>
            <div style={styles.footer}>
              <button type="button" onClick={() => setStepIndex(index => Math.max(0, index - 1))} disabled={isFirstStep} style={styles.secondaryBtn}>Zurueck</button>
              <div style={styles.footerActions}>
                {!isLastStep && <button type="button" onClick={closeTour} style={styles.ghostBtn}>Ueberspringen</button>}
                <button
                  type="button"
                  onClick={() => {
                    if (isLastStep) closeTour()
                    else setStepIndex(index => Math.min(STEPS.length - 1, index + 1))
                  }}
                  style={styles.primaryBtn}
                >
                  {isLastStep ? 'Fertig' : 'Weiter'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
  },
  trigger: {
    background: 'color-mix(in srgb, var(--surface-2) 72%, transparent)',
    color: 'var(--fg)',
    border: '1px solid color-mix(in srgb, var(--muted-fg) 28%, transparent)',
    borderRadius: 999,
    padding: '0.42rem 0.8rem',
    fontSize: '0.8rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  welcomeCard: {
    position: 'absolute',
    top: 'calc(100% + 0.65rem)',
    right: 0,
    width: 300,
    background: 'color-mix(in srgb, var(--surface) 98%, transparent)',
    border: '1px solid color-mix(in srgb, var(--border) 95%, transparent)',
    borderRadius: 14,
    padding: '0.9rem 0.95rem',
    boxShadow: '0 18px 42px rgba(2, 6, 23, 0.34)',
    zIndex: 35,
  },
  welcomeEyebrow: {
    color: 'var(--muted-fg)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontSize: '0.7rem',
    fontWeight: 700,
    marginBottom: '0.35rem',
  },
  welcomeTitle: {
    fontWeight: 700,
    fontSize: '0.95rem',
    marginBottom: '0.35rem',
    color: 'var(--fg)',
  },
  welcomeBody: {
    color: 'var(--fg)',
    fontSize: '0.82rem',
    lineHeight: 1.5,
  },
  welcomeActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.5rem',
    marginTop: '0.85rem',
  },
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(2, 6, 23, 0.64)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1.5rem',
    zIndex: 40,
  },
  modal: {
    width: 'min(560px, 100%)',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 18,
    padding: '1.25rem',
    boxShadow: '0 24px 80px rgba(2, 6, 23, 0.45)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '1rem',
    marginBottom: '1rem',
  },
  eyebrow: {
    color: 'var(--accent)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontSize: '0.74rem',
    fontWeight: 700,
  },
  title: { margin: '0.2rem 0 0 0', fontSize: '1.4rem' },
  closeBtn: {
    background: 'none',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '0.45rem 0.8rem',
    cursor: 'pointer',
  },
  progressRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    marginBottom: '0.95rem',
  },
  progressText: {
    color: 'var(--muted-fg)',
    fontSize: '0.78rem',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  progressDots: { display: 'flex', gap: '0.35rem' },
  progressDot: {
    width: 9,
    height: 9,
    borderRadius: 999,
    border: 'none',
    background: 'var(--border)',
    padding: 0,
    cursor: 'pointer',
  },
  progressDotActive: { background: 'var(--accent)' },
  card: {
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '0.95rem 1rem',
    marginBottom: '0.85rem',
  },
  cardFocus: {
    color: 'var(--accent)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontSize: '0.72rem',
    fontWeight: 700,
    marginBottom: '0.45rem',
  },
  cardTitle: { fontWeight: 700, marginBottom: '0.35rem' },
  cardBody: { color: 'var(--fg)', lineHeight: 1.55, fontSize: '0.92rem' },
  hintBand: {
    background: 'color-mix(in srgb, var(--surface-2) 80%, transparent)',
    border: '1px solid color-mix(in srgb, var(--border) 80%, transparent)',
    borderRadius: 12,
    padding: '0.75rem 0.85rem',
    color: 'var(--fg)',
    fontSize: '0.82rem',
    lineHeight: 1.5,
    marginBottom: '0.95rem',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  footerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  primaryBtn: {
    background: 'var(--accent)',
    color: '#eff6ff',
    border: '1px solid var(--accent)',
    borderRadius: 999,
    padding: '0.45rem 0.9rem',
    fontSize: '0.82rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  secondaryBtn: {
    background: 'none',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: 999,
    padding: '0.45rem 0.9rem',
    fontSize: '0.82rem',
    cursor: 'pointer',
  },
  ghostBtn: {
    background: 'none',
    color: 'var(--muted-fg)',
    border: 'none',
    padding: '0.45rem 0.35rem',
    fontSize: '0.82rem',
    cursor: 'pointer',
  },
}