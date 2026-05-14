import { useQuery } from '@tanstack/react-query'
import { getAIModels, type AIModelResponse } from '../lib/requests'
import { useState, useRef, useEffect } from 'react'
import { useAIChat } from '../ctx/useAIChat'
import { useSourceFilter } from '../ctx/useSourceFilter'
import HelpTip from '../components/HelpTip'
import { useI18n } from '../ctx/I18nContext'

function ReferencedLogs({ lines }: { lines: string[] }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginTop: '0.75rem', borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.78rem', padding: 0 }}
      >
        {open ? '▼' : '▶'} {t('ai.referencesCount', { count: lines.length })}
      </button>
      {open && (
        <div style={{ marginTop: '0.4rem', background: 'var(--surface-2)', borderRadius: 6, padding: '0.5rem 0.75rem', maxHeight: 220, overflowY: 'auto' }}>
          {lines.map((l, i) => (
            <div key={i} style={{
              fontFamily: 'monospace', fontSize: '0.75rem', lineHeight: 1.5, wordBreak: 'break-all',
              color: /error|crit|fatal|emerg/i.test(l) ? '#f87171' : /warn/i.test(l) ? '#fbbf24' : '#94a3b8',
              borderBottom: '1px solid var(--border)', paddingBottom: '0.1rem',
            }}>{l}</div>
          ))}
        </div>
      )}
    </div>
  )
}

function ContextBadge({ attachedContext }: { attachedContext: { title: string; summary: string } | null }) {
  const { t } = useI18n()
  const { filter } = useSourceFilter()
  const { selectedSources } = useSourceFilter()

  const hasFilter = filter.sourceIds.length > 0 || filter.sourcePaths.length > 0

  const rangeLabel = filter.rangeHours === 0
    ? t('ai.range.all')
    : filter.rangeHours <= 1 ? t('ai.range.lastHour')
    : filter.rangeHours <= 6 ? t('ai.range.lastHours', { count: filter.rangeHours })
    : filter.rangeHours <= 24 ? t('ai.range.last24h')
    : filter.rangeHours <= 168 ? t('ai.range.last7d')
    : t('ai.range.last30d')

  if (!hasFilter && !attachedContext) {
    return (
      <div style={badgeStyles.wrap}>
        <span style={badgeStyles.noFilter}>
          ⚠ {t('ai.noFilter')}
        </span>
      </div>
    )
  }

  return (
    <div style={badgeStyles.wrap}>
      <span style={badgeStyles.label}>Kontext:</span>
      {hasFilter && <span style={badgeStyles.pill}>🕐 {rangeLabel}</span>}
      {selectedSources.map(s => (
        <span key={s.id} style={{ ...badgeStyles.pill, background: 'var(--accent-soft)', color: 'var(--accent-fg)' }}>
          {s.label}
        </span>
      ))}
      {attachedContext && (
        <span style={{ ...badgeStyles.pill, background: 'color-mix(in srgb, var(--accent) 16%, var(--surface))', color: 'var(--accent-fg)' }}>
          Netzkontext: {attachedContext.title}
        </span>
      )}
    </div>
  )
}

const badgeStyles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.35rem', padding: '0.4rem 0.75rem', background: 'var(--surface-2)', borderRadius: 8, border: '1px solid var(--border)', marginBottom: '0.75rem', fontSize: '0.8rem' },
  label: { color: 'var(--muted-fg)', marginRight: '0.15rem', flexShrink: 0 },
  pill: { background: 'var(--surface)', color: 'var(--muted-fg)', borderRadius: 12, padding: '0.15rem 0.55rem', border: '1px solid var(--border)' },
  noFilter: { color: 'var(--warning-fg)', fontSize: '0.8rem' },
}

export default function AIChatPage() {
  const { t } = useI18n()
  const { data: models = [] } = useQuery({ queryKey: ['ai-models'], queryFn: getAIModels })
  const { messages, model, setModel, pendingCount, send, clearMessages, attachedContext, clearAttachedContext } = useAIChat()
  const [draft, setDraft] = useState({ text: '', appliedPrompt: '' })
  const bottomRef = useRef<HTMLDivElement>(null)
  const selectedModel = model || models[0]?.name || ''
  const attachedPrompt = attachedContext?.prompt?.trim() ?? ''
  const input = draft.text || (draft.appliedPrompt === attachedPrompt ? '' : attachedPrompt)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function handleSend() {
    if (!input.trim() || pendingCount > 0) return
    if (model !== selectedModel) setModel(selectedModel)
    send(input.trim(), selectedModel)
    setDraft({ text: '', appliedPrompt: attachedPrompt })
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <div style={styles.titleRow}>
          <h2 style={styles.h2}>AI Chat</h2>
          <HelpTip content="Der Chat beantwortet Fragen zu Logs, Vorfaellen und angehaengtem Netzwerk-Kontext. Die aktuelle Kontextkarte zeigt, was bei der naechsten Frage mitgesendet wird." ariaLabel="AI Chat erklaeren" />
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {messages.length > 0 && (
            <button onClick={clearMessages} style={styles.clearBtn} title={t('ai.clearHistory')}>✕ {t('ai.history')}</button>
          )}
          <div style={styles.modelWrap}>
            <select value={selectedModel} onChange={e => setModel(e.target.value)} style={styles.select}>
              {models.map((m: AIModelResponse) => <option key={m.name} value={m.name}>{m.name}</option>)}
            </select>
            <HelpTip content="Hier waehlst du das lokale Sprachmodell fuer die Analyse aus. Unterschiedliche Modelle reagieren unterschiedlich schnell und tiefgehend." ariaLabel="Modellauswahl erklaeren" />
          </div>
        </div>
      </div>

      <ContextBadge attachedContext={attachedContext ? { title: attachedContext.title, summary: attachedContext.summary } : null} />

      {attachedContext && (
        <div style={styles.contextPanel}>
          <div>
            <div style={styles.contextTitleRow}>
              <strong>{attachedContext.title}</strong>
              <HelpTip content="Dieser strukturierte Kontext wird automatisch zusammen mit deiner naechsten Chat-Nachricht an die AI uebergeben." ariaLabel="Netzwerk-Kontext erklaeren" />
            </div>
            <div style={styles.contextBody}>{attachedContext.summary}</div>
          </div>
          <button type="button" onClick={clearAttachedContext} style={styles.contextBtn}>{t('ai.removeContext')}</button>
        </div>
      )}

      <div style={styles.messages}>
        {messages.length === 0 && (
          <div style={styles.placeholder}>
            {t('ai.placeholder')}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ ...styles.bubble, ...(m.role === 'user' ? styles.userBubble : styles.aiBubble), ...(m.error ? styles.errorBubble : {}) }}>
            <span style={styles.role}>{m.role === 'user' ? 'Du' : model}</span>
            {m.pending
              ? <span style={{ color: '#64748b' }}>{t('ai.thinking')}</span>
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
        <div style={styles.inputHelpWrap}>
          <HelpTip content="Beschreibe das Problem oder stelle eine konkrete Frage. Der angezeigte Kontext und die referenzierten Logs werden der AI als Hilfsmaterial mitgegeben." ariaLabel="Eingabefeld erklaeren" />
        </div>
        <textarea
          value={input}
          onChange={e => setDraft({ text: e.target.value, appliedPrompt: attachedPrompt })}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
          placeholder={t('ai.inputPlaceholder')}
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
  titleRow: { display: 'flex', alignItems: 'center', gap: '0.5rem' },
  h2: { margin: 0, fontSize: '1.5rem' },
  modelWrap: { display: 'flex', alignItems: 'center', gap: '0.45rem' },
  select: { background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.4rem 0.75rem', minWidth: 220 },
  clearBtn: { background: 'none', border: '1px solid var(--border)', color: 'var(--muted-fg)', borderRadius: 6, padding: '0.35rem 0.65rem', cursor: 'pointer', fontSize: '0.78rem' },
  contextPanel: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '1rem',
    alignItems: 'center',
    padding: '0.8rem 0.95rem',
    borderRadius: 12,
    border: '1px solid var(--accent)',
    background: 'color-mix(in srgb, var(--accent) 10%, var(--surface))',
    marginBottom: '0.85rem',
  },
  contextTitleRow: { display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.25rem' },
  contextBody: { color: 'var(--fg)', fontSize: '0.84rem', lineHeight: 1.5 },
  contextBtn: {
    background: 'none',
    border: '1px solid var(--accent)',
    color: 'var(--accent-fg)',
    borderRadius: 8,
    padding: '0.45rem 0.75rem',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  messages: {
    flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column',
    gap: '1rem', paddingRight: '0.5rem', marginBottom: '1rem',
  },
  placeholder: { color: 'var(--muted-fg)', textAlign: 'center', padding: '3rem 0', fontSize: '0.9rem' },
  bubble: { borderRadius: 10, padding: '0.75rem 1rem', maxWidth: '80%' },
  userBubble: { background: 'var(--accent-soft)', alignSelf: 'flex-end' },
  aiBubble: { background: 'var(--surface)', border: '1px solid var(--border)', alignSelf: 'flex-start' },
  errorBubble: { borderColor: 'var(--danger-fg)', background: 'color-mix(in srgb, var(--danger-fg) 12%, var(--surface))' },
  role: { fontSize: '0.72rem', fontWeight: 700, color: 'var(--muted-fg)', display: 'block', marginBottom: '0.35rem' },
  pre: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.88rem', fontFamily: 'inherit' },
  inputRow: { display: 'flex', gap: '0.75rem', alignItems: 'flex-end' },
  inputHelpWrap: { paddingBottom: '0.4rem' },
  textarea: {
    flex: 1, background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)',
    borderRadius: 8, padding: '0.65rem 0.85rem', fontSize: '0.9rem',
    resize: 'none', outline: 'none',
  },
  sendBtn: {
    background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8,
    width: 48, height: 48, fontSize: '1.1rem', cursor: 'pointer', flexShrink: 0,
  },
}
