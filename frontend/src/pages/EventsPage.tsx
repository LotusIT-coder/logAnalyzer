import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { getEvents, getSources } from '../lib/requests'
import dayjs from 'dayjs'
import { getApiBase, getStoredToken } from '../lib/api'

const SEV_COLOR: Record<string, string> = {
  critical: '#ef4444',
  error: '#f97316',
  warning: '#eab308',
  info: '#22c55e',
  debug: '#6366f1',
}

const SEVERITIES = ['debug', 'info', 'warning', 'error', 'critical']

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
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Zeilen filtern..."
              style={modal.filterInput}
            />
            <button onClick={() => setPaused(v => !v)} style={modal.ctrlBtn}>{paused ? 'Weiter' : 'Pause'}</button>
            <button onClick={() => setLines([])} style={modal.ctrlBtn}>Leeren</button>
            <button onClick={onClose} style={{ ...modal.ctrlBtn, color: '#f87171' }}>x Schliessen</button>
          </div>
        </div>

        {error && <div style={{ color: '#f87171', padding: '0.5rem 1rem', fontSize: '0.82rem' }}>{error}</div>}

        <div style={modal.log}>
          {displayed.map((line, i) => (
            <div
              key={i}
              style={{
                ...modal.logLine,
                color: /error|crit|fatal|emerg/i.test(line)
                  ? '#f87171'
                  : /warn/i.test(line)
                    ? '#fbbf24'
                    : /debug/i.test(line)
                      ? '#6366f1'
                      : '#d1fae5',
              }}
            >
              {line}
            </div>
          ))}
          {!displayed.length && <div style={{ color: '#475569', padding: '1rem' }}>{connected ? 'Warte auf neue Zeilen...' : 'Keine Daten'}</div>}
          <div ref={bottomRef} />
        </div>

        <div style={modal.footer}>{displayed.length} Zeilen | {source.config?.path}</div>
      </div>
    </div>
  )
}

export default function EventsPage() {
  const [cursor, setCursor] = useState<string | undefined>()
  const [sourceId, setSourceId] = useState('')
  const [severity, setSeverity] = useState('')
  const [host, setHost] = useState('')
  const [service, setService] = useState('')
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [refreshTick, setRefreshTick] = useState(0)
  const [tailSource, setTailSource] = useState<any | null>(null)

  const { data: sourcesRaw = [] } = useQuery({ queryKey: ['sources'], queryFn: getSources })
  const sources: any[] = Array.isArray(sourcesRaw) ? sourcesRaw : []
  const selectedSource = sourceId ? sources.find((s: any) => s.id === sourceId) ?? null : null

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['events', cursor, sourceId, severity, host, service, search, refreshTick],
    queryFn: () => getEvents({
      limit: 50,
      cursor: cursor || undefined,
      source_id: sourceId || undefined,
      severity: severity || undefined,
      host: host || undefined,
      service: service || undefined,
      q: search || undefined,
    }),
  })

  function applySearch() {
    setCursor(undefined)
    setSearch(searchInput)
  }

  function resetFilters() {
    setCursor(undefined)
    setSourceId('')
    setSeverity('')
    setHost('')
    setService('')
    setSearch('')
    setSearchInput('')
  }

  function toggleExpand(id: string) {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  }

  function refreshLatest() {
    setExpanded({})
    setCursor(undefined)
    setRefreshTick(v => v + 1)
  }

  const hasFilters = sourceId || severity || host || service || search

  return (
    <div>
      {tailSource && <LiveTailModal source={tailSource} onClose={() => setTailSource(null)} />}

      <div style={styles.header}>
        <h2 style={styles.h2}>Events</h2>
        <button onClick={refreshLatest} disabled={isFetching} style={styles.refBtn}>
          {isFetching ? 'Aktualisiere...' : 'Aktualisieren'}
        </button>
      </div>

      <div style={styles.filters}>
        <select value={sourceId} onChange={e => { setSourceId(e.target.value); setCursor(undefined) }} style={{ ...styles.select, minWidth: 220 }}>
          <option value="">Alle Quellen</option>
          {sources.map((s: any) => (
            <option key={s.id} value={s.id}>{s.name}{s.config?.path ? ` (${s.config.path})` : ''}</option>
          ))}
        </select>
        <button
          onClick={() => selectedSource && setTailSource(selectedSource)}
          disabled={!selectedSource || selectedSource.type !== 'file'}
          style={!selectedSource || selectedSource.type !== 'file' ? styles.liveBtnDisabled : styles.liveBtn}
          title={!selectedSource ? 'Zuerst Quelle auswaehlen' : selectedSource.type !== 'file' ? 'Nur fuer Datei-Quellen' : 'Live-Ansicht fuer gewaehlte Quelle'}
        >
          Live-Ansicht
        </button>

        <select value={severity} onChange={e => { setSeverity(e.target.value); setCursor(undefined) }} style={styles.select}>
          <option value="">Alle Schweregrade</option>
          {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input
          value={host}
          onChange={e => setHost(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && (setCursor(undefined))}
          placeholder="Host filtern..."
          style={{ ...styles.search, flex: '0 0 140px' }}
        />
        <input
          value={service}
          onChange={e => setService(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && (setCursor(undefined))}
          placeholder="Service filtern..."
          style={{ ...styles.search, flex: '0 0 140px' }}
        />
        <input
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && applySearch()}
          placeholder="Nachricht suchen..."
          style={styles.search}
        />
        <button onClick={applySearch} style={styles.btn}>Suchen</button>
        {hasFilters && (
          <button onClick={resetFilters} style={styles.resetBtn}>Filter zurücksetzen</button>
        )}
      </div>

      {isLoading ? (
        <div style={{ color: '#64748b', padding: '2rem' }}>Lade...</div>
      ) : (
        <>
          <div style={{ fontSize: '0.78rem', color: '#475569', marginBottom: '0.5rem' }}>
            {data?.items.length ?? 0} Einträge (neueste zuerst)
          </div>
          <div style={styles.table}>
            <div style={styles.theader}>
              <span style={{ width: 150 }}>Zeitstempel</span>
              <span style={{ width: 75 }}>Severity</span>
              <span style={{ width: 110 }}>Host</span>
              <span style={{ width: 120 }}>Service</span>
              <span style={{ flex: 1 }}>Nachricht</span>
            </div>
            {data?.items.map((ev: any) => (
              <div key={ev.id}>
                <div
                  style={{ ...styles.row, cursor: 'pointer', background: expanded[ev.id] ? '#162032' : undefined }}
                  onClick={() => toggleExpand(ev.id)}
                  title="Klicken zum Expandieren"
                >
                  <span style={{ width: 150, color: '#64748b', flexShrink: 0, fontSize: '0.78rem' }}>
                    {dayjs(ev.timestamp).format('DD.MM.YY HH:mm:ss')}
                  </span>
                  <span style={{ width: 75, flexShrink: 0 }}>
                    <span style={{ ...styles.badge, background: SEV_COLOR[ev.severity] ?? '#475569' }}>
                      {ev.severity}
                    </span>
                  </span>
                  <span style={{ width: 110, color: '#64748b', flexShrink: 0, fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ev.host ?? '-'}
                  </span>
                  <span style={{ width: 120, color: '#94a3b8', flexShrink: 0, fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ev.service ?? '-'}
                  </span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.85rem' }}>
                    {ev.message}
                  </span>
                </div>
                {expanded[ev.id] && (
                  <div style={styles.detail}>
                    <div style={styles.detailGrid}>
                      <span style={styles.detailLabel}>ID</span><span style={styles.detailVal}>{ev.id}</span>
                      <span style={styles.detailLabel}>Quelle</span><span style={styles.detailVal}>{ev.source_id ?? '-'}</span>
                      <span style={styles.detailLabel}>Zeitstempel</span><span style={styles.detailVal}>{dayjs(ev.timestamp).format('DD.MM.YYYY HH:mm:ss.SSS')}</span>
                      <span style={styles.detailLabel}>Host</span><span style={styles.detailVal}>{ev.host ?? '-'}</span>
                      <span style={styles.detailLabel}>Service</span><span style={styles.detailVal}>{ev.service ?? '-'}</span>
                      <span style={styles.detailLabel}>Severity</span><span style={styles.detailVal}>{ev.severity}</span>
                    </div>
                    <div style={{ marginTop: '0.5rem' }}>
                      <span style={styles.detailLabel}>Nachricht:</span>
                      <pre style={styles.detailPre}>{ev.message}</pre>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {!data?.items.length && (
              <div style={{ padding: '2rem', color: '#64748b', textAlign: 'center' }}>Keine Events gefunden</div>
            )}
          </div>

          <div style={styles.pagination}>
            {cursor && (
              <button onClick={() => setCursor(undefined)} style={styles.btn}>Neueste</button>
            )}
            {data?.next_cursor && (
              <button onClick={() => setCursor(data.next_cursor)} style={styles.btn}>Aeltere laden</button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' },
  h2: { margin: 0, fontSize: '1.5rem' },
  refBtn: { background: 'none', border: '1px solid #334155', color: '#94a3b8', borderRadius: 6, padding: '0.35rem 0.75rem', cursor: 'pointer', opacity: 1 },
  liveBtn: { background: '#1e3a5f', border: '1px solid #1d4ed8', color: '#93c5fd', borderRadius: 6, padding: '0.4rem 0.9rem', cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' },
  liveBtnDisabled: { background: '#0f172a', border: '1px solid #334155', color: '#64748b', borderRadius: 6, padding: '0.4rem 0.9rem', cursor: 'not-allowed', fontWeight: 700, whiteSpace: 'nowrap' },
  filters: { display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' },
  select: { background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '0.4rem 0.6rem' },
  search: { flex: 1, minWidth: 120, background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '0.4rem 0.75rem' },
  btn: { background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, padding: '0.4rem 0.9rem', cursor: 'pointer', whiteSpace: 'nowrap' },
  resetBtn: { background: 'none', border: '1px solid #475569', color: '#64748b', borderRadius: 6, padding: '0.4rem 0.9rem', cursor: 'pointer', whiteSpace: 'nowrap' },
  table: { background: '#1e293b', borderRadius: 10, border: '1px solid #334155', overflow: 'hidden' },
  theader: {
    display: 'flex', gap: '1rem', padding: '0.6rem 1rem',
    background: '#0f172a', color: '#475569', fontSize: '0.73rem', fontWeight: 700, textTransform: 'uppercase',
  },
  row: {
    display: 'flex', gap: '1rem', padding: '0.5rem 1rem',
    borderTop: '1px solid #1e293b', alignItems: 'center',
  },
  badge: {
    display: 'inline-block', borderRadius: 4, padding: '0 0.4rem',
    fontSize: '0.7rem', fontWeight: 700, color: '#fff',
  },
  pagination: { display: 'flex', gap: '0.75rem', marginTop: '1rem', justifyContent: 'flex-end' },
  detail: {
    background: '#0f172a', borderTop: '1px solid #334155',
    padding: '0.75rem 1rem 0.75rem 2rem', fontSize: '0.82rem',
  },
  detailGrid: {
    display: 'grid', gridTemplateColumns: '100px 1fr',
    gap: '0.25rem 0.75rem',
  },
  detailLabel: { color: '#475569', fontWeight: 700 },
  detailVal: { color: '#94a3b8', fontFamily: 'monospace' },
  detailPre: {
    margin: '0.25rem 0 0', padding: '0.5rem', background: '#1e293b',
    borderRadius: 6, color: '#d1fae5', fontFamily: 'monospace',
    fontSize: '0.78rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
  },
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
