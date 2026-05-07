import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getSources, createSource, testSource, patchSource, deleteSource } from '../lib/requests'
import { useEffect, useRef, useState } from 'react'
import { getApiBase, getStoredToken } from '../lib/api'
import { hasScope, useAuth } from '../ctx/AuthContext'
import HelpTip from '../components/HelpTip'

// ─── Edit Modal ───────────────────────────────────────────────────────────────
function EditSourceModal({ source, onClose, onSaved }: { source: any; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(source.name ?? '')
  const [path, setPath] = useState(source.config?.path ?? '')
  const [enabled, setEnabled] = useState(source.enabled ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    setSaving(true)
    setError('')
    try {
      await patchSource(source.id, { name, config: { path }, enabled })
      onSaved()
      onClose()
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? 'Fehler beim Speichern.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={modal.overlay} onClick={onClose}>
      <div style={{ ...modal.box, height: 'auto', maxWidth: 540, padding: '1.5rem' }} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 1rem 0', fontSize: '1rem', color: '#f1f5f9' }}>Quelle bearbeiten</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={styles.field}>
            <label style={styles.label}>Name</label>
            <input value={name} onChange={e => setName(e.target.value)} style={styles.input} />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Dateipfad</label>
            <input value={path} onChange={e => setPath(e.target.value)} style={styles.input} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.88rem', color: '#94a3b8', cursor: 'pointer' }}>
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
            Aktiv
          </label>
        </div>
        {error && <div style={{ color: '#f87171', fontSize: '0.82rem', marginTop: '0.5rem' }}>{error}</div>}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.25rem' }}>
          <button onClick={handleSave} disabled={saving || !name || !path} style={styles.saveBtn}>
            {saving ? 'Speichere...' : 'Speichern'}
          </button>
          <button onClick={onClose} style={modal.ctrlBtn}>Abbrechen</button>
        </div>
      </div>
    </div>
  )
}

// ─── Live-Tail Modal ──────────────────────────────────────────────────────────
function LiveTailModal({ source, onClose }: { source: any; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState('')
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(false)
  pausedRef.current = paused

  useEffect(() => {
    const token = getStoredToken()
    const url = `${getApiBase()}/sources/${source.id}/tail?lines=100&token=${encodeURIComponent(token ?? '')}`
    const es = new EventSource(url)

    es.onopen = () => setConnected(true)
    es.onmessage = (e) => {
      if (pausedRef.current) return
      setLines(prev => {
        const next = [...prev, e.data]
        return next.length > 2000 ? next.slice(-2000) : next
      })
    }
    es.onerror = () => {
      setError('Verbindung unterbrochen.')
      setConnected(false)
      es.close()
    }

    return () => { es.close() }
  }, [source.id])

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines, paused])

  const displayed = filter
    ? lines.filter(l => l.toLowerCase().includes(filter.toLowerCase()))
    : lines

  return (
    <div style={modal.overlay} onClick={onClose}>
      <div style={modal.box} onClick={e => e.stopPropagation()}>
        <div style={modal.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>Live-Tail: {source.name}</span>
            <span style={{ ...modal.dot, background: connected ? '#22c55e' : '#ef4444' }} />
            <span style={{ fontSize: '0.75rem', color: '#64748b' }}>{connected ? 'verbunden' : 'getrennt'}</span>
            {paused && <span style={{ fontSize: '0.72rem', color: '#f97316', fontWeight: 700 }}>PAUSIERT</span>}
            <HelpTip content="Pause stoppt nur den sichtbaren Stream, Leeren entfernt den bisherigen Puffer und der Filter wirkt nur auf die gerade angezeigten Zeilen." ariaLabel="Live-Tail erklaeren" />
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Zeilen filtern..."
              style={modal.filterInput}
            />
            <button onClick={() => setPaused(v => !v)} style={modal.ctrlBtn}>
              {paused ? 'Weiter' : 'Pause'}
            </button>
            <button onClick={() => setLines([])} style={modal.ctrlBtn}>Leeren</button>
            <button onClick={onClose} style={{ ...modal.ctrlBtn, color: '#f87171' }}>x Schliessen</button>
          </div>
        </div>

        {error && <div style={{ color: '#f87171', padding: '0.5rem 1rem', fontSize: '0.82rem' }}>{error}</div>}

        <div style={modal.log}>
          {displayed.map((line, i) => (
            <div key={i} style={{
              ...modal.logLine,
              color: /error|crit|fatal|emerg/i.test(line) ? '#f87171'
                : /warn/i.test(line) ? '#fbbf24'
                : /debug/i.test(line) ? '#6366f1'
                : '#d1fae5',
            }}>
              {line}
            </div>
          ))}
          {!displayed.length && (
            <div style={{ color: '#475569', padding: '1rem' }}>
              {connected ? 'Warte auf neue Zeilen...' : 'Keine Daten'}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div style={modal.footer}>
          {displayed.length} Zeilen{filter ? ` (gefiltert aus ${lines.length})` : ''}
          &nbsp;|&nbsp;{source.config?.path}
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function SourcesPage() {
  const qc = useQueryClient()
  const { me } = useAuth()
  const canWrite = hasScope(me, 'write')
  const { data, isLoading } = useQuery({ queryKey: ['sources'], queryFn: getSources })
  const [showNew, setShowNew] = useState(false)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [testResults, setTestResults] = useState<Record<string, any>>({})
  const [tailSource, setTailSource] = useState<any | null>(null)
  const [editSource, setEditSource] = useState<any | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  async function handleCreate() {
    setSaving(true)
    try {
      await createSource({ name, type: 'file', config: { path }, enabled: true })
      qc.invalidateQueries({ queryKey: ['sources'] })
      setShowNew(false)
      setName('')
      setPath('')
    } finally {
      setSaving(false)
    }
  }

  async function handleTest(id: string) {
    const r = await testSource(id)
    setTestResults(prev => ({ ...prev, [id]: r }))
  }

  async function handleDelete(id: string) {
    setPendingDelete(null)
    await deleteSource(id)
    qc.invalidateQueries({ queryKey: ['sources'] })
  }

  const sources: any[] = Array.isArray(data) ? data : []

  return (
    <div>
      {tailSource && <LiveTailModal source={tailSource} onClose={() => setTailSource(null)} />}
      {editSource && <EditSourceModal source={editSource} onClose={() => setEditSource(null)} onSaved={() => qc.invalidateQueries({ queryKey: ['sources'] })} />}

      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <h2 style={styles.h2}>Log-Quellen</h2>
          <HelpTip content="Hier verwaltest du die angebundenen Logdateien. Quellen koennen getestet, live beobachtet, bearbeitet und bei Bedarf entfernt werden." ariaLabel="Log-Quellen erklaeren" />
        </div>
        {canWrite && (
          <button onClick={() => setShowNew(v => !v)} style={styles.addBtn}>
            {showNew ? 'x Abbrechen' : '+ Neue Quelle'}
          </button>
        )}
      </div>

      <div style={{ ...styles.liveHint, display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <span>
          Live-Ansicht wird pro Quelle gestartet: bei der gewuenschten Quelle auf <strong>Live-Ansicht</strong> klicken.
        </span>
        <HelpTip content="Die Live-Ansicht zeigt neu eintreffende Logzeilen der gewaehlten Datei in Echtzeit. Das ist besonders hilfreich nach Parser-, Ingestion- oder Quellenaenderungen." ariaLabel="Live-Ansicht der Quellen erklaeren" />
      </div>

      {!canWrite && (
        <div style={styles.readOnlyNotice}>
          Quellen koennen mit diesem Token nur gelesen und getestet werden.
        </div>
      )}

      {canWrite && showNew && (
        <div style={styles.form}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <h3 style={{ margin: 0, fontSize: '0.95rem', color: '#94a3b8' }}>Neue Quelle (Typ: file)</h3>
            <HelpTip content="Lege hier eine neue Datei-Quelle an. Der Name erscheint spaeter in Filtern und Listen, waehrend der Dateipfad auf die tatsaechliche Logdatei zeigt." ariaLabel="Neue Quelle erklaeren" />
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <div style={styles.field}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <label style={styles.label}>Name</label>
                <HelpTip content="Verstaendlicher Anzeigename fuer die Quelle. Dieser Name wird spaeter in Filtern, Reports und Drilldowns verwendet." ariaLabel="Quellname erklaeren" />
              </div>
              <input value={name} onChange={e => setName(e.target.value)} style={styles.input} placeholder="z.B. syslog" />
            </div>
            <div style={{ ...styles.field, flex: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <label style={styles.label}>Dateipfad</label>
                <HelpTip content="Absoluter Pfad zur Logdatei auf dem Host. Nur aus dieser Datei wird spaeter eingelesen oder live getailt." ariaLabel="Dateipfad erklaeren" />
              </div>
              <input value={path} onChange={e => setPath(e.target.value)} style={styles.input} placeholder="/var/log/syslog" />
            </div>
          </div>
          <button onClick={handleCreate} disabled={saving || !name || !path} style={styles.saveBtn}>
            {saving ? 'Speichere...' : 'Erstellen'}
          </button>
        </div>
      )}

      {isLoading ? (
        <div style={{ color: '#64748b', padding: '2rem' }}>Lade...</div>
      ) : (
        <>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>Quellenbestand</span>
            <HelpTip content="Jede Karte zeigt Status, Typ, Dateipfad und die wichtigsten Aktionen der Quelle. Testen prueft die Erreichbarkeit, Live-Ansicht streamt neue Zeilen, Bearbeiten aendert Konfigurationen." ariaLabel="Quellenkarten erklaeren" />
          </div>
          <div style={styles.list}>
            {sources.map(src => (
              <div key={src.id} style={styles.card}>
              <div style={styles.cardTop}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span style={styles.srcName}>{src.name}</span>
                  <span style={{ ...styles.badge, background: src.enabled ? '#16a34a' : '#475569' }}>
                    {src.enabled ? 'aktiv' : 'inaktiv'}
                  </span>
                  <span style={{ ...styles.badge, background: '#1e3a5f', color: '#93c5fd' }}>
                    {src.type}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <button
                    onClick={() => setTailSource(src)}
                    disabled={src.type !== 'file'}
                    style={src.type === 'file' ? styles.tailBtn : styles.tailBtnDisabled}
                    title={src.type === 'file' ? 'Live-Tail oeffnen' : 'Live-Ansicht nur fuer Datei-Quellen'}
                  >
                    Live-Ansicht
                  </button>
                  {canWrite && (
                    <button onClick={() => setEditSource(src)} style={styles.testBtn}>
                      Bearbeiten
                    </button>
                  )}
                  <button onClick={() => handleTest(src.id)} style={styles.testBtn}>
                    Testen
                  </button>
                  {canWrite && pendingDelete === src.id ? (
                    <>
                      <span style={{ fontSize: '0.82rem', color: '#fca5a5', alignSelf: 'center' }}>Wirklich löschen?</span>
                      <button onClick={() => handleDelete(src.id)} style={{ ...styles.deleteBtn, background: '#7f1d1d' }}>Ja</button>
                      <button onClick={() => setPendingDelete(null)} style={styles.testBtn}>Abbrechen</button>
                    </>
                  ) : canWrite ? (
                    <button onClick={() => setPendingDelete(src.id)} style={styles.deleteBtn}>Löschen</button>
                  ) : null}
                </div>
              </div>
              <div style={styles.path}>{src.config?.path ?? '-'}</div>
              {testResults[src.id] && (
                <div style={{ marginTop: '0.5rem', fontSize: '0.82rem', color: testResults[src.id].ok ? '#22c55e' : '#f87171' }}>
                  {testResults[src.id].ok
                    ? 'Erreichbar'
                    : `Fehler: ${testResults[src.id].error ?? testResults[src.id].details}`}
                </div>
              )}
              </div>
            ))}
            {!sources.length && (
              <div style={styles.emptyState}>
                <div style={{ marginBottom: '0.6rem' }}>Keine Quellen konfiguriert.</div>
                <button onClick={() => setShowNew(true)} style={styles.addBtn}>+ Erste Quelle anlegen</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' },
  h2: { margin: 0, fontSize: '1.5rem' },
  addBtn: { background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, padding: '0.5rem 1rem', cursor: 'pointer', fontWeight: 600 },
  liveHint: { background: '#10223f', color: '#bfdbfe', border: '1px solid #1e3a8a', borderRadius: 8, padding: '0.65rem 0.9rem', marginBottom: '1rem', fontSize: '0.86rem' },
  readOnlyNotice: { background: '#1f2937', color: '#cbd5e1', border: '1px solid #334155', borderRadius: 8, padding: '0.65rem 0.9rem', marginBottom: '1rem', fontSize: '0.86rem' },
  form: { background: '#1e293b', borderRadius: 10, padding: '1.25rem', border: '1px solid #334155', marginBottom: '1.5rem' },
  field: { display: 'flex', flexDirection: 'column', gap: '0.3rem', flex: 1 },
  label: { color: '#64748b', fontSize: '0.78rem' },
  input: { background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '0.4rem 0.65rem', fontSize: '0.9rem' },
  saveBtn: { marginTop: '0.75rem', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, padding: '0.5rem 1.25rem', cursor: 'pointer', fontWeight: 600 },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' },
  sectionTitle: { color: '#94a3b8', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' },
  list: { display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  card: { background: '#1e293b', borderRadius: 10, padding: '1rem 1.25rem', border: '1px solid #334155' },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem', flexWrap: 'wrap', gap: '0.5rem' },
  srcName: { fontWeight: 600, fontSize: '0.95rem' },
  badge: { borderRadius: 4, padding: '0.12rem 0.5rem', fontSize: '0.72rem', fontWeight: 700, color: '#fff' },
  path: { fontSize: '0.82rem', color: '#64748b', fontFamily: 'monospace' },
  testBtn: { background: 'none', border: '1px solid #334155', color: '#94a3b8', borderRadius: 6, padding: '0.35rem 0.85rem', cursor: 'pointer', fontSize: '0.84rem' },
  tailBtn: { background: '#1e3a5f', border: '1px solid #1d4ed8', color: '#93c5fd', borderRadius: 6, padding: '0.35rem 0.9rem', cursor: 'pointer', fontSize: '0.84rem', fontWeight: 700 },
  tailBtnDisabled: { background: '#0f172a', border: '1px solid #334155', color: '#64748b', borderRadius: 6, padding: '0.35rem 0.9rem', cursor: 'not-allowed', fontSize: '0.84rem', fontWeight: 700 },
  deleteBtn: { background: 'none', border: '1px solid #7f1d1d', color: '#f87171', borderRadius: 6, padding: '0.35rem 0.85rem', cursor: 'pointer', fontSize: '0.84rem' },
  emptyState: { padding: '2rem', color: '#64748b', textAlign: 'center' },
}

const modal: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  box: {
    background: '#0f172a', border: '1px solid #334155', borderRadius: 12,
    width: '90vw', maxWidth: 1100, height: '80vh',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0.75rem 1rem', borderBottom: '1px solid #334155', flexWrap: 'wrap', gap: '0.5rem',
  },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0, display: 'inline-block' },
  filterInput: {
    background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155',
    borderRadius: 6, padding: '0.3rem 0.65rem', fontSize: '0.82rem', width: 200,
  },
  ctrlBtn: {
    background: '#1e293b', color: '#94a3b8', border: '1px solid #334155',
    borderRadius: 6, padding: '0.3rem 0.65rem', cursor: 'pointer', fontSize: '0.82rem',
  },
  log: {
    flex: 1, overflowY: 'auto', padding: '0.5rem 1rem',
    fontFamily: 'monospace', fontSize: '0.78rem', lineHeight: 1.5,
  },
  logLine: { padding: '0.08rem 0', borderBottom: '1px solid #0f172a', wordBreak: 'break-all' },
  footer: {
    padding: '0.4rem 1rem', borderTop: '1px solid #1e293b',
    fontSize: '0.72rem', color: '#475569',
  },
}
