import { useSocAlertModal } from '../ctx/SocAlertModalContext'

export default function SocAlertModalStack() {
  const { modals, closeModal } = useSocAlertModal()

  if (!modals.length) return null

  return (
    <div style={{ position: 'fixed', zIndex: 10000, top: 0, left: 0, width: '100vw', height: '100vh', pointerEvents: 'none' }}>
      {modals.map((modal, idx) => {
        // Details extrahieren
        let details = typeof modal.details === 'string' ? {} : (modal.details || {})
        let suspicion = details.suspicion || details.reason || details.soc_reason || details.soc_suspicion || ''
        let eventType = details.event_type || details.type || ''
        let source = details.source_name || details.source || details.source_id || ''
        let host = details.host || ''
        let severity = details.severity || details.level || ''
        let time = modal.timestamp || details.timestamp || ''
        let message = modal.message || details.message || ''
        let summary = details.summary || ''
        let extra = details.extra || details
        return (
          <div
            key={modal.id}
            style={{
              position: 'absolute',
              top: 40 + idx * 32,
              left: '50%',
              transform: 'translateX(-50%)',
              width: 'min(92vw, 600px)',
              background: 'var(--surface)',
              color: 'var(--fg)',
              border: '2px solid var(--danger-fg)',
              borderRadius: 12,
              boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
              padding: '2rem 2.5rem 1.5rem 2.5rem',
              pointerEvents: 'auto',
              transition: 'top 0.2s',
              fontSize: 18,
              fontWeight: 600,
              textAlign: 'center',
            }}
          >
            <button
              onClick={() => closeModal(modal.id)}
              style={{
                position: 'absolute',
                top: 12,
                right: 18,
                background: 'none',
                border: 'none',
                color: 'var(--danger-fg)',
                fontSize: 28,
                fontWeight: 700,
                cursor: 'pointer',
                lineHeight: 1,
                zIndex: 2,
              }}
              aria-label="Schließen"
            >×</button>
            <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 12, color: 'var(--danger-fg)' }}>{modal.title}</div>
            <div style={{ marginBottom: 10, whiteSpace: 'pre-line' }}>{message}</div>
            {summary && <div style={{ marginBottom: 10, color: 'var(--danger-fg)', fontWeight: 600 }}>{summary}</div>}
            <div style={{ display: 'flex', justifyContent: 'center', gap: 24, marginBottom: 10, fontSize: 15, flexWrap: 'wrap' }}>
              {severity && <span><b>Stufe:</b> {severity}</span>}
              {eventType && <span><b>Typ:</b> {eventType}</span>}
              {source && <span><b>Quelle:</b> {source}</span>}
              {host && <span><b>Host:</b> {host}</span>}
            </div>
            {suspicion && (
              <div style={{
                background: 'var(--surface-2)',
                color: 'var(--fg)',
                border: '1px solid var(--border)',
                borderLeft: '4px solid var(--warning-fg)',
                borderRadius: 8,
                padding: '0.7em 1em',
                margin: '0.5em 0 1em 0',
                fontSize: 16,
                fontWeight: 500,
                boxShadow: '0 2px 8px rgba(255,193,7,0.08)'
              }}>
                <b>Verdachtsmoment:</b> {suspicion}
              </div>
            )}
            <div style={{ fontSize: 13, color: 'var(--muted-fg)', marginBottom: 12 }}>{time}</div>
            {/* Optional: weitere Details */}
            {extra && typeof extra === 'object' && Object.keys(extra).length > 0 && (
              <details style={{ textAlign: 'left', margin: '0.5em auto', maxWidth: 520, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 14 }}>
                <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--danger-fg)' }}>Technische Details</summary>
                <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, color: 'var(--fg)' }}>{JSON.stringify(extra, null, 2)}</pre>
              </details>
            )}
            <button
              style={{
                background: 'var(--danger-fg)',
                color: 'var(--bg)',
                border: '1px solid var(--danger-fg)',
                borderRadius: 6,
                padding: '0.5rem 1.5rem',
                fontWeight: 700,
                fontSize: 16,
                cursor: 'pointer',
                marginTop: 8,
              }}
              onClick={() => closeModal(modal.id)}
            >
              Alarm schließen
            </button>
          </div>
        )
      })}
    </div>
  )
}
