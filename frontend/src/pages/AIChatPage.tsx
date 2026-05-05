import { useQuery } from '@tanstack/react-query'
import { getAIModels } from '../lib/requests'
import { useState, useRef, useEffect } from 'react'
import { useAIChat } from '../ctx/AIChatContext'
import { useSourceFilter } from '../ctx/SourceFilterContext'

function ReferencedLogs({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginTop: '0.75rem', borderTop: '1px solid #334155', paddingTop: '0.5rem' }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', fontSize: '0.78rem', padding: 0 }}
      >
        {open ? '▼' : '▶'} {lines.length} referenzierte Log-Zeile{lines.length !== 1 ? 'n' : ''}
      </button>
      {open && (
        <div style={{ marginTop: '0.4rem', background: '#0f172a', borderRadius: 6, padding: '0.5rem 0.75rem', maxHeight: 220, overflowY: 'auto' }}>
          {lines.map((l, i) => (
            <div key={i} style={{
              fontFamily: 'monospace', fontSize: '0.75rem', lineHeight: 1.5, wordBreak: 'break-all',
              color: /error|crit|fatal|emerg/i.test(l) ? '#f87171' : /warn/i.test(l) ? '#fbbf24' : '#94a3b8',
              borderBottom: '1px solid #1e293b', paddingBottom: '0.1rem',
            }}>{l}</div>
          ))}
        </div>
      )}
    </div>
  )
}

function ContextBadge() {
  const { filter } = useSourceFilter()
  const { selectedSources } = useSourceFilter()

  const hasFilter = filter.sourceIds.length > 0 || filter.sourcePaths.length > 0

  const rangeLabel = filter.rangeHours === 0
    ? 'Alle Einträge'
    : filter.rangeHours <= 1 ? 'Letzte Stunde'
    : filter.rangeHours <= 6 ? `Letzte ${filter.rangeHours} Stunden`
    : filter.rangeHours <= 24 ? 'Letzte 24 Stunden'
    : filter.rangeHours <= 168 ? 'Letzte 7 Tage'
    : 'Letzte 30 Tage'

  if (!hasFilter) {
    return (
      <div style={badgeStyles.wrap}>
        <span style={badgeStyles.noFilter}>
          ⚠ Kein Quellfilter gesetzt – bitte im Dashboard eine Quelle auswählen
        </span>
      </div>
    )
  }

  return (
    <div style={badgeStyles.wrap}>
      <span style={badgeStyles.label}>Kontext:</span>
      <span style={badgeStyles.pill}>🕐 {rangeLabel}</span>
      {selectedSources.map(s => (
        <span key={s.id} style={{ ...badgeStyles.pill, background: '#1e3a5f', color: '#93c5fd' }}>
          {s.label}
        </span>
      ))}
    </div>
  )
}

const badgeStyles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.35rem', padding: '0.4rem 0.75rem', background: '#0f172a', borderRadius: 8, border: '1px solid #1e293b', marginBottom: '0.75rem', fontSize: '0.8rem' },
  label: { color: '#475569', marginRight: '0.15rem', flexShrink: 0 },
  pill: { background: '#1e293b', color: '#94a3b8', borderRadius: 12, padding: '0.15rem 0.55rem', border: '1px solid #334155' },
  noFilter: { color: '#fbbf24', fontSize: '0.8rem' },
}

export default function AIChatPage() {
  const { data: models = [] } = useQuery({ queryKey: ['ai-models'], queryFn: getAIModels })
  const { messages, model, setModel, pendingCount, send, clearMessages } = useAIChat()
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (models.length && !model) setModel((models[0] as any).name)
  }, [models])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function handleSend() {
    if (!input.trim() || pendingCount > 0) return
    send(input.trim())
    setInput('')
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <h2 style={styles.h2}>AI Chat</h2>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {messages.length > 0 && (
            <button onClick={clearMessages} style={styles.clearBtn} title="Verlauf löschen">✕ Verlauf</button>
          )}
          <select value={model} onChange={e => setModel(e.target.value)} style={styles.select}>
            {(models as any[]).map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
          </select>
        </div>
      </div>

      <ContextBadge />

      <div style={styles.messages}>
        {messages.length === 0 && (
          <div style={styles.placeholder}>
            Stelle eine Frage zu deinen Log-Daten oder analysiere einen Fehler.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ ...styles.bubble, ...(m.role === 'user' ? styles.userBubble : styles.aiBubble), ...(m.error ? styles.errorBubble : {}) }}>
            <span style={styles.role}>{m.role === 'user' ? 'Du' : model}</span>
            {m.pending
              ? <span style={{ color: '#64748b' }}>Denkt nach…</span>
              : <pre style={styles.pre}>{m.content}</pre>
            }
            {m.references && m.references.length > 0 && (
              <ReferencedLogs lines={m.references} />
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div style={styles.inputRow}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
          placeholder="Nachricht eingeben… (Enter zum Senden, Shift+Enter für Zeilenumbruch)"
          rows={3}
          style={styles.textarea}
          disabled={pendingCount > 0}
        />
        <button onClick={handleSend} disabled={pendingCount > 0 || !input.trim()} style={styles.sendBtn}>
          ➤
        </button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 4rem)' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' },
  h2: { margin: 0, fontSize: '1.5rem' },
  select: { background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '0.4rem 0.75rem', minWidth: 220 },
  clearBtn: { background: 'none', border: '1px solid #334155', color: '#64748b', borderRadius: 6, padding: '0.35rem 0.65rem', cursor: 'pointer', fontSize: '0.78rem' },
  messages: {
    flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column',
    gap: '1rem', paddingRight: '0.5rem', marginBottom: '1rem',
  },
  placeholder: { color: '#475569', textAlign: 'center', padding: '3rem 0', fontSize: '0.9rem' },
  bubble: { borderRadius: 10, padding: '0.75rem 1rem', maxWidth: '80%' },
  userBubble: { background: '#1e3a5f', alignSelf: 'flex-end' },
  aiBubble: { background: '#1e293b', border: '1px solid #334155', alignSelf: 'flex-start' },
  errorBubble: { borderColor: '#7f1d1d', background: '#1c0a0a' },
  role: { fontSize: '0.72rem', fontWeight: 700, color: '#64748b', display: 'block', marginBottom: '0.35rem' },
  pre: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.88rem', fontFamily: 'inherit' },
  inputRow: { display: 'flex', gap: '0.75rem', alignItems: 'flex-end' },
  textarea: {
    flex: 1, background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155',
    borderRadius: 8, padding: '0.65rem 0.85rem', fontSize: '0.9rem',
    resize: 'none', outline: 'none',
  },
  sendBtn: {
    background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8,
    width: 48, height: 48, fontSize: '1.1rem', cursor: 'pointer', flexShrink: 0,
  },
}
