import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getEvents, getSources, type EventResponse, type SourceResponse } from '../lib/requests'
import dayjs from 'dayjs'
import { getApiBase } from '../lib/api'
import HelpTip from '../components/HelpTip'
import GlobalSourceFilterNotice from '../components/GlobalSourceFilterNotice'
import { useSourceFilter } from '../ctx/useSourceFilter'
import { type SourceOption } from '../ctx/SourceFilterContext.shared'

const SEV_COLOR: Record<string, string> = {
  critical: '#ef4444',
  error: '#f97316',
  warning: '#eab308',
  info: '#22c55e',
  debug: '#6366f1',
}

const SEVERITIES = ['debug', 'info', 'warning', 'error', 'critical']

function parseSeverityCsv(value: string) {
  return value
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)
}

function getInitialFilterValue(searchParams: URLSearchParams, key: string) {
  return searchParams.get(key) ?? ''
}

function formatDateRange(fromTime: string, toTime: string) {
  if (!fromTime && !toTime) return null
  const fromLabel = fromTime ? dayjs(fromTime).format('DD.MM.YYYY HH:mm') : 'offen'
  const toLabel = toTime ? dayjs(toTime).format('DD.MM.YYYY HH:mm') : 'jetzt'
  return `${fromLabel} - ${toLabel}`
}

function buildContextItems(params: {
  sourceId: string
  sourceIdsCsv: string
  sourcePathsCsv: string
  fromTime: string
  toTime: string
  severityCsv: string
  host: string
  service: string
  search: string
  sources: SourceResponse[]
}) {
  const items: string[] = []
  const source = params.sourceId ? params.sources.find(entry => entry.id === params.sourceId) : null
  const sourceIds = params.sourceIdsCsv ? params.sourceIdsCsv.split(',').map(value => value.trim()).filter(Boolean) : []
  const sourcePaths = params.sourcePathsCsv ? params.sourcePathsCsv.split(',').map(value => value.trim()).filter(Boolean) : []
  const rangeLabel = formatDateRange(params.fromTime, params.toTime)

  if (source) items.push(`Quelle: ${source.name}`)
  else if (params.sourceId) items.push(`Quelle: ${params.sourceId}`)
  if (sourceIds.length) items.push(`Quellen: ${sourceIds.length}`)
  if (sourcePaths.length) items.push(`Pfade: ${sourcePaths.length}`)
  if (rangeLabel) items.push(`Zeitraum: ${rangeLabel}`)
  if (params.severityCsv) {
    const labels = params.severityCsv.split(',').map(value => value.trim()).filter(Boolean)
    if (labels.length) items.push(`Severity: ${labels.join(', ')}`)
  }
  if (params.host) items.push(`Host: ${params.host}`)
  if (params.service) items.push(`Service: ${params.service}`)
  if (params.search) items.push(`Suche: ${params.search}`)

  return items
}

function LiveTailModal({ source, onClose }: { source: SourceResponse; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState('')
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(false)

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  useEffect(() => {
    const url = `${getApiBase()}/sources/${source.id}/tail?lines=100`
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
  const { filter: globalFilter, setFilter: setGlobalFilter, selectedSources, setSelectedSources } = useSourceFilter()
  const [searchParams] = useSearchParams()
  const [sourceId, setSourceId] = useState(() => getInitialFilterValue(searchParams, 'source_id'))
  const [sourceIdsCsv, setSourceIdsCsv] = useState(() => getInitialFilterValue(searchParams, 'source_ids'))
  const [sourcePathsCsv, setSourcePathsCsv] = useState(() => getInitialFilterValue(searchParams, 'source_paths'))
  const [fromTime, setFromTime] = useState(() => getInitialFilterValue(searchParams, 'from'))
  const [toTime, setToTime] = useState(() => getInitialFilterValue(searchParams, 'to'))
  const [selectedSeverities, setSelectedSeverities] = useState<string[]>(() => parseSeverityCsv(getInitialFilterValue(searchParams, 'severity')))
  const [host, setHost] = useState(() => getInitialFilterValue(searchParams, 'host'))
  const [service, setService] = useState(() => getInitialFilterValue(searchParams, 'service'))
  const [search, setSearch] = useState(() => getInitialFilterValue(searchParams, 'q'))
  const [searchInput, setSearchInput] = useState(() => getInitialFilterValue(searchParams, 'q'))
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [refreshTick, setRefreshTick] = useState(0)
  const [tailSource, setTailSource] = useState<SourceResponse | null>(null)
  const tableContainerRef = useRef<HTMLDivElement>(null)

  const { data: sources = [] } = useQuery({ queryKey: ['sources'], queryFn: getSources })
  const selectedSource = sourceId ? sources.find(source => source.id === sourceId) ?? null : null
  const globalSourceIdsCsv = globalFilter.sourceIds.join(',')
  const globalSourcePathsCsv = globalFilter.sourcePaths.join(',')
  const globalSingleSourceId = globalFilter.sourceIds.length === 1 && globalFilter.sourcePaths.length === 0
    ? globalFilter.sourceIds[0]
    : ''
  const globalSingleSourcePath = globalFilter.sourcePaths.length === 1 && globalFilter.sourceIds.length === 0
    ? globalFilter.sourcePaths[0]
    : ''
  const showGlobalFilterNotice = !(
    (globalSingleSourceId && sourceId === globalSingleSourceId) ||
    (globalSingleSourcePath && !sourceId && sourcePathsCsv === globalSingleSourcePath)
  )
  const effectiveSourceIdsCsv = sourceIdsCsv || (!sourceId ? globalSourceIdsCsv : '')
  const effectiveSourcePathsCsv = sourcePathsCsv || (!sourceId ? globalSourcePathsCsv : '')

  const sourcePathOptions = Array.from(new Set([
    ...globalFilter.sourcePaths,
    ...selectedSources.filter(source => source.kind === 'preset' || source.kind === 'custom').map(source => source.path),
  ]))

  const sourceSelectValue = sourceId
    ? `source:${sourceId}`
    : (sourcePathsCsv ? `path:${sourcePathsCsv}` : '')
  const selectedSeveritiesCsv = selectedSeverities.join(',')

  useEffect(() => {
    // Keep Events dropdown aligned with global dashboard/source context.
    if (globalSingleSourceId) {
      if (sourceId !== globalSingleSourceId || sourcePathsCsv) {
        setSourceId(globalSingleSourceId)
        setSourceIdsCsv('')
        setSourcePathsCsv('')
      }
      return
    }

    if (globalSingleSourcePath) {
      if (sourceId || sourcePathsCsv !== globalSingleSourcePath) {
        setSourceId('')
        setSourceIdsCsv('')
        setSourcePathsCsv(globalSingleSourcePath)
      }
      return
    }

    if (sourceId || sourceIdsCsv || sourcePathsCsv) {
      setSourceId('')
      setSourceIdsCsv('')
      setSourcePathsCsv('')
    }
  }, [globalSingleSourceId, globalSingleSourcePath, sourceId, sourceIdsCsv, sourcePathsCsv])

  // Infinite query: loads events page by page
  const { data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage, isFetching } = useInfiniteQuery({
    queryKey: ['events', sourceId, effectiveSourceIdsCsv, effectiveSourcePathsCsv, fromTime, toTime, selectedSeveritiesCsv, host, service, search, refreshTick],
    queryFn: ({ pageParam }: { pageParam?: string }) => getEvents({
      limit: 100,
      cursor: pageParam,
      from: fromTime || undefined,
      to: toTime || undefined,
      source_id: sourceId || undefined,
      source_ids: effectiveSourceIdsCsv || undefined,
      source_paths: effectiveSourcePathsCsv || undefined,
      severity: selectedSeveritiesCsv || undefined,
      host: host || undefined,
      service: service || undefined,
      q: search || undefined,
    }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    staleTime: 30_000,
  })

  // Flatten all pages into single events array
  const allEvents = data?.pages.flatMap(page => page.items) ?? []

  // Scroll observer: trigger next page fetch when user scrolls near bottom
  const observerRef = useRef<IntersectionObserver | null>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = tableContainerRef.current
    if (!container || !hasNextPage || isFetchingNextPage) return

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container
      // Trigger when user scrolls to 80% of content
      if (scrollTop + clientHeight >= scrollHeight * 0.8) {
        fetchNextPage()
      }
    }

    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  function applySearch() {
    setSearch(searchInput)
  }

  function resetFilters() {
    setSourceId('')
    setSourceIdsCsv('')
    setSourcePathsCsv('')
    setFromTime('')
    setToTime('')
    setSelectedSeverities([])
    setHost('')
    setService('')
    setSearch('')
    setSearchInput('')
    setGlobalFilter({ sourceIds: [], sourcePaths: [], rangeHours: globalFilter.rangeHours })
    setSelectedSources([])
  }

  function handleSourceChange(nextSourceValue: string) {
    const nextSourceId = nextSourceValue.startsWith('source:') ? nextSourceValue.slice('source:'.length) : ''
    const nextSourcePath = nextSourceValue.startsWith('path:') ? nextSourceValue.slice('path:'.length) : ''

    setSourceId(nextSourceId)
    setSourceIdsCsv('')
    setSourcePathsCsv(nextSourcePath)

    if (!nextSourceId && !nextSourcePath) {
      setGlobalFilter({ sourceIds: [], sourcePaths: [], rangeHours: globalFilter.rangeHours })
      setSelectedSources([])
      return
    }

    if (nextSourcePath) {
      const pathLabel = nextSourcePath.split('/').pop() ?? nextSourcePath
      setGlobalFilter({ sourceIds: [], sourcePaths: [nextSourcePath], rangeHours: globalFilter.rangeHours })
      setSelectedSources([{ id: `preset:${nextSourcePath}`, label: pathLabel, path: nextSourcePath, kind: 'preset' }])
      return
    }

    const selected = sources.find(source => source.id === nextSourceId)
    const nextSelectedSources: SourceOption[] = selected
      ? [{
        id: `source:${selected.id}`,
        label: selected.name,
        path: selected.config?.path ?? '',
        kind: 'configured',
      }]
      : []

    setGlobalFilter({ sourceIds: [nextSourceId], sourcePaths: [], rangeHours: globalFilter.rangeHours })
    setSelectedSources(nextSelectedSources)
  }

  function toggleExpand(id: string) {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  }

  function refreshLatest() {
    setExpanded({})
    setRefreshTick(v => v + 1)
  }

  const hasFilters = sourceId || sourceIdsCsv || sourcePathsCsv || fromTime || toTime || selectedSeveritiesCsv || host || service || search
  const contextItems = buildContextItems({
    sourceId,
    sourceIdsCsv: effectiveSourceIdsCsv,
    sourcePathsCsv: effectiveSourcePathsCsv,
    fromTime,
    toTime,
    severityCsv: selectedSeveritiesCsv,
    host,
    service,
    search,
    sources,
  })

  return (
    <div>
      {tailSource && <LiveTailModal source={tailSource} onClose={() => setTailSource(null)} />}

      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <h2 style={styles.h2}>Events</h2>
          <HelpTip content="Die Eventliste zeigt Rohereignisse mit allen aktiven Filtern. Ein Klick auf eine Zeile oeffnet die Detailansicht des jeweiligen Events." ariaLabel="Events erklaeren" />
        </div>
        <button onClick={refreshLatest} disabled={isFetching} style={styles.refBtn}>
          {isFetching ? 'Aktualisiere...' : 'Aktualisieren'}
        </button>
      </div>

      {showGlobalFilterNotice && <GlobalSourceFilterNotice />}

      <div style={styles.filters}>
        <select value={sourceSelectValue} onChange={e => handleSourceChange(e.target.value)} style={{ ...styles.select, minWidth: 220 }}>
          <option value="">Alle Quellen</option>
          {sources.map((source: SourceResponse) => (
            <option key={source.id} value={`source:${source.id}`}>{source.name}{source.config?.path ? ` (${source.config.path})` : ''}</option>
          ))}
          {sourcePathOptions.map(path => {
            const label = path.split('/').pop() ?? path
            return <option key={`path:${path}`} value={`path:${path}`}>{label} ({path})</option>
          })}
        </select>
        <HelpTip content="Filtert die Eventliste auf genau eine konfigurierte Quelle. Die Live-Ansicht ist nur aktiv, wenn hier eine Datei-Quelle ausgewaehlt wurde." ariaLabel="Quellenfilter erklaeren" />
        <button onClick={refreshLatest} disabled={isFetching} style={styles.refBtn}>
          {isFetching ? 'Refresh...' : 'Refresh'}
        </button>
        <button
          onClick={() => selectedSource && setTailSource(selectedSource)}
          disabled={!selectedSource || selectedSource.type !== 'file'}
          style={!selectedSource || selectedSource.type !== 'file' ? styles.liveBtnDisabled : styles.liveBtn}
          title={!selectedSource ? 'Zuerst Quelle auswaehlen' : selectedSource.type !== 'file' ? 'Nur fuer Datei-Quellen' : 'Live-Ansicht fuer gewaehlte Quelle'}
        >
          Live-Ansicht
        </button>
        <HelpTip content="Die Live-Ansicht streamt neue Zeilen der aktuell gewaehlten Datei-Quelle direkt in ein Tail-Fenster. Damit pruefst du schnell, ob gerade frische Daten ankommen." ariaLabel="Live-Ansicht erklaeren" />

        <details style={styles.severityDropdown}>
          <summary style={styles.severitySummary}>
            {selectedSeverities.length > 0
              ? `${selectedSeverities.length} Schweregrade`
              : 'Alle Schweregrade'}
          </summary>
          <div style={styles.severityMenu}>
            {SEVERITIES.map(level => {
              const checked = selectedSeverities.includes(level)
              return (
                <label key={level} style={styles.severityOption}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      setSelectedSeverities(prev => (
                        prev.includes(level)
                          ? prev.filter(value => value !== level)
                          : [...prev, level]
                      ))
                      setCursor(undefined)
                    }}
                  />
                  <span style={{ textTransform: 'capitalize' }}>{level}</span>
                </label>
              )
            })}
            <div style={{ display: 'flex', gap: '0.35rem', marginTop: '0.3rem' }}>
              <button
                type="button"
                style={styles.severityActionBtn}
                onClick={() => {
                  setSelectedSeverities(SEVERITIES)
                  setCursor(undefined)
                }}
              >
                Alle
              </button>
              <button
                type="button"
                style={styles.severityActionBtn}
                onClick={() => {
                  setSelectedSeverities([])
                  setCursor(undefined)
                }}
              >
                Keine
              </button>
            </div>
          </div>
        </details>
        <HelpTip content="Schweregrade helfen beim Priorisieren. Fehler und kritische Events deuten auf unmittelbaren Handlungsbedarf hin, waehrend Info- und Debug-Events meist Kontext liefern." ariaLabel="Severity-Filter erklaeren" />
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
        <HelpTip content="Die Textsuche durchsucht die Eventnachricht. Host- und Service-Felder grenzen dagegen strukturierte Metadaten ein." ariaLabel="Textsuche erklaeren" />
        <button onClick={applySearch} style={styles.btn}>Suchen</button>
        {hasFilters && (
          <button onClick={resetFilters} style={styles.resetBtn}>Filter zurücksetzen</button>
        )}
      </div>

      {contextItems.length > 0 && (
        <div aria-label="Aktiver Kontext" style={styles.contextBar}>
          <span style={styles.contextLabel}>Aktiver Kontext</span>
          <HelpTip content="Diese Chips zeigen, welche Quelle, Zeit- oder Inhaltsfilter aktuell aktiv sind. So erkennst du sofort, warum die Eventliste gerade so eingeschraenkt ist." ariaLabel="Aktiven Kontext erklaeren" />
          {contextItems.map(item => (
            <span key={item} style={styles.contextChip}>{item}</span>
          ))}
        </div>
      )}

      {isLoading ? (
        <div style={{ color: '#64748b', padding: '2rem' }}>Lade...</div>
      ) : (
        <>
          <div style={styles.resultsMeta}>
            <span>{allEvents.length} Einträge geladen (neueste zuerst)</span>
            {hasNextPage && <span style={{ color: '#64748b' }}>↓ Scrollen zum Laden von mehr</span>}
            <HelpTip content="Die Liste ist standardmaessig absteigend nach Zeit sortiert. Scrolle nach unten um weitere Events zu laden. Ein Klick auf eine Zeile klappt die vollstaendigen Felder aus." ariaLabel="Eventliste erklaeren" />
          </div>
          <div ref={tableContainerRef} style={styles.tableContainer}>
            <div style={styles.table}>
              <div style={styles.theader}>
                <span style={{ width: 150 }}>Zeitstempel</span>
                <span style={{ width: 75 }}>Severity</span>
                <span style={{ width: 110 }}>Host</span>
                <span style={{ width: 120 }}>Service</span>
                <span style={{ flex: 1 }}>Nachricht</span>
              </div>
              {allEvents.map((event: EventResponse) => (
                <div key={event.id}>
                  <div
                    style={{ ...styles.row, cursor: 'pointer', background: expanded[event.id] ? '#162032' : undefined }}
                    onClick={() => toggleExpand(event.id)}
                    title="Klicken zum Expandieren"
                  >
                    <span style={{ width: 150, color: '#64748b', flexShrink: 0, fontSize: '0.78rem' }}>
                      {dayjs(event.timestamp).format('DD.MM.YY HH:mm:ss')}
                    </span>
                    <span style={{ width: 75, flexShrink: 0 }}>
                      <span style={{ ...styles.badge, background: SEV_COLOR[event.severity] ?? '#475569' }}>
                        {event.severity}
                      </span>
                    </span>
                    <span style={{ width: 110, color: '#64748b', flexShrink: 0, fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {event.host ?? '-'}
                    </span>
                    <span style={{ width: 120, color: '#94a3b8', flexShrink: 0, fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {event.service ?? '-'}
                    </span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.85rem' }}>
                      {event.message}
                    </span>
                  </div>
                  {expanded[event.id] && (
                    <div style={styles.detail}>
                      <div style={styles.detailGrid}>
                        <span style={styles.detailLabel}>ID</span><span style={styles.detailVal}>{event.id}</span>
                        <span style={styles.detailLabel}>Quelle</span><span style={styles.detailVal}>{event.source_id ?? '-'}</span>
                        <span style={styles.detailLabel}>Zeitstempel</span><span style={styles.detailVal}>{dayjs(event.timestamp).format('DD.MM.YYYY HH:mm:ss.SSS')}</span>
                        <span style={styles.detailLabel}>Host</span><span style={styles.detailVal}>{event.host ?? '-'}</span>
                        <span style={styles.detailLabel}>Service</span><span style={styles.detailVal}>{event.service ?? '-'}</span>
                        <span style={styles.detailLabel}>Severity</span><span style={styles.detailVal}>{event.severity}</span>
                      </div>
                      <div style={{ marginTop: '0.5rem' }}>
                        <span style={styles.detailLabel}>Nachricht:</span>
                        <pre style={styles.detailPre}>{event.message}</pre>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {!allEvents.length && (
                <div style={{ padding: '2rem', color: '#64748b', textAlign: 'center' }}>Keine Events gefunden</div>
              )}
              {isFetchingNextPage && (
                <div style={{ padding: '1rem', textAlign: 'center', color: '#64748b', fontSize: '0.85rem' }}>
                  Lade weitere Events...
                </div>
              )}
            </div>
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
  contextBar: {
    display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem',
    background: '#111827', border: '1px solid #1f2937', borderRadius: 10, padding: '0.75rem 0.9rem',
  },
  contextLabel: { color: '#94a3b8', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.08em' },
  contextChip: { background: '#0f2d46', color: '#bae6fd', borderRadius: 999, padding: '0.2rem 0.65rem', fontSize: '0.82rem' },
  resultsMeta: { display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem', color: '#475569', marginBottom: '0.5rem' },
  select: { background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '0.4rem 0.6rem' },
  severityDropdown: { position: 'relative' },
  severitySummary: {
    background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6,
    padding: '0.4rem 0.6rem', listStyle: 'none', cursor: 'pointer', minWidth: 160,
  },
  severityMenu: {
    position: 'absolute', top: 'calc(100% + 0.3rem)', left: 0, zIndex: 30,
    minWidth: 180, background: '#0f172a', border: '1px solid #334155', borderRadius: 8,
    padding: '0.45rem 0.55rem', boxShadow: '0 10px 24px rgba(2, 6, 23, 0.5)',
  },
  severityOption: {
    display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#cbd5e1',
    fontSize: '0.84rem', padding: '0.18rem 0',
  },
  severityActionBtn: {
    background: '#1e293b', color: '#93c5fd', border: '1px solid #334155', borderRadius: 6,
    padding: '0.2rem 0.5rem', fontSize: '0.75rem', cursor: 'pointer',
  },
  search: { flex: 1, minWidth: 120, background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '0.4rem 0.75rem' },
  btn: { background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, padding: '0.4rem 0.9rem', cursor: 'pointer', whiteSpace: 'nowrap' },
  resetBtn: { background: 'none', border: '1px solid #475569', color: '#64748b', borderRadius: 6, padding: '0.4rem 0.9rem', cursor: 'pointer', whiteSpace: 'nowrap' },
  tableContainer: {
    maxHeight: 'calc(100vh - 450px)',
    overflowY: 'auto' as const,
    borderRadius: 10,
    border: '1px solid #334155',
    background: '#1e293b',
  },
  table: { background: '#1e293b', borderRadius: 10, border: '1px solid #334155', overflow: 'hidden' },
  theader: {
    display: 'flex', gap: '1rem', padding: '0.6rem 1rem',
    background: '#0f172a', color: '#475569', fontSize: '0.73rem', fontWeight: 700, textTransform: 'uppercase',
    position: 'sticky' as const,
    top: 0,
    zIndex: 10,
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
