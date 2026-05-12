import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getEvents, getSources, type EventResponse, type SourceResponse } from '../lib/requests'
import dayjs from 'dayjs'
import { getApiBase } from '../lib/api'
import HelpTip from '../components/HelpTip'
import GlobalSourceFilterNotice from '../components/GlobalSourceFilterNotice'
import { SourcePicker, type UploadResultState, isUploadError } from '../components/SourcePicker'
import { TimeRangePicker } from '../components/TimeRangePicker'
import { type SourceOption } from '../ctx/SourceFilterContext.shared'
import { useSourceFilter } from '../ctx/useSourceFilter'

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
  if (sourceIds.length === 1) {
    const srcName = params.sources.find(s => s.id === sourceIds[0])?.name ?? sourceIds[0]
    items.push(`Quelle: ${srcName}`)
  } else if (sourceIds.length > 1) {
    items.push(`Quellen: ${sourceIds.length}`)
    const names = sourceIds.map(id => params.sources.find(s => s.id === id)?.name ?? id)
    items.push(`Mehrfachauswahl: ${names.join(', ')}`)
  }
  if (sourcePaths.length === 1) {
    items.push(`Pfad: ${sourcePaths[0].split('/').pop() ?? sourcePaths[0]}`)
  } else if (sourcePaths.length > 1) {
    items.push(`Pfade: ${sourcePaths.length}`)
    const pathNames = sourcePaths.map(p => p.split('/').pop() ?? p)
    items.push(`Mehrfachauswahl: ${pathNames.join(', ')}`)
  }
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

interface TailLine {
  text: string
  sourceId: string
  sourceName: string
  seq: number
}

const SOURCE_COLORS = ['#7dd3fc', '#fbbf24', '#a78bfa', '#34d399', '#fb7185', '#60a5fa', '#f97316', '#c084fc']

function LiveTailModal({ sources, onClose }: { sources: SourceResponse[]; onClose: () => void }) {
  const [lines, setLines] = useState<TailLine[]>([])
  const [connected, setConnected] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState<string>('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(false)
  const seqRef = useRef(0)

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  const sourceColor = useMemo(() => {
    const map: Record<string, string> = {}
    sources.forEach((s, i) => { map[s.id] = SOURCE_COLORS[i % SOURCE_COLORS.length] })
    return map
  }, [sources])

  useEffect(() => {
    const eventSources: EventSource[] = []
    sources.forEach(source => {
      const url = `${getApiBase()}/sources/${source.id}/tail?lines=100`
      const es = new EventSource(url)
      es.onopen = () => setConnected(prev => ({ ...prev, [source.id]: true }))
      es.onmessage = (e) => {
        if (pausedRef.current) return
        seqRef.current += 1
        const seq = seqRef.current
        setLines(prev => {
          const next = [...prev, { text: e.data, sourceId: source.id, sourceName: source.name, seq }]
          return next.length > 2000 ? next.slice(-2000) : next
        })
      }
      es.onerror = () => {
        setErrors(prev => ({ ...prev, [source.id]: 'Verbindung unterbrochen.' }))
        setConnected(prev => ({ ...prev, [source.id]: false }))
        es.close()
      }
      eventSources.push(es)
    })
    return () => { eventSources.forEach(es => es.close()) }
  }, [sources])

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines, paused])

  const displayed = lines.filter(l => {
    if (sourceFilter && l.sourceId !== sourceFilter) return false
    if (filter && !l.text.toLowerCase().includes(filter.toLowerCase())) return false
    return true
  })

  const allConnected = sources.every(s => connected[s.id])
  const anyConnected = sources.some(s => connected[s.id])
  const errorList = Object.entries(errors).filter(([id]) => sources.find(s => s.id === id))
  const showSourceTag = sources.length > 1
  const title = sources.length === 1 ? `Live-Tail: ${sources[0].name}` : `Live-Tail: ${sources.length} Quellen`

  return (
    <div style={modal.overlay} onClick={onClose}>
      <div style={modal.box} onClick={e => e.stopPropagation()}>
        <div style={modal.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>{title}</span>
            <span style={{ ...modal.dot, background: allConnected ? '#22c55e' : anyConnected ? '#fbbf24' : '#ef4444' }} />
            <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
              {allConnected ? 'alle verbunden' : anyConnected ? `${sources.filter(s => connected[s.id]).length}/${sources.length} verbunden` : 'getrennt'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {showSourceTag && (
              <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} style={modal.filterInput}>
                <option value="">Alle Quellen</option>
                {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
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

        {showSourceTag && (
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', padding: '0.4rem 1rem', borderBottom: '1px solid #1e293b', fontSize: '0.72rem' }}>
            {sources.map(s => (
              <span key={s.id} style={{ color: sourceColor[s.id], display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: sourceColor[s.id], display: 'inline-block' }} />
                {s.name}
                <span style={{ color: connected[s.id] ? '#22c55e' : '#ef4444' }}>●</span>
              </span>
            ))}
          </div>
        )}

        {errorList.length > 0 && (
          <div style={{ color: '#f87171', padding: '0.5rem 1rem', fontSize: '0.82rem' }}>
            {errorList.map(([id, msg]) => {
              const s = sources.find(x => x.id === id)
              return <div key={id}>{s?.name ?? id}: {msg}</div>
            })}
          </div>
        )}

        <div style={modal.log}>
          {displayed.map((line) => (
            <div
              key={line.seq}
              style={{
                ...modal.logLine,
                color: /error|crit|fatal|emerg/i.test(line.text)
                  ? '#f87171'
                  : /warn/i.test(line.text)
                    ? '#fbbf24'
                    : /debug/i.test(line.text)
                      ? '#6366f1'
                      : '#d1fae5',
              }}
            >
              {showSourceTag && (
                <span style={{ color: sourceColor[line.sourceId], marginRight: '0.5rem', fontWeight: 600 }}>
                  [{line.sourceName}]
                </span>
              )}
              {line.text}
            </div>
          ))}
          {!displayed.length && <div style={{ color: '#475569', padding: '1rem' }}>{anyConnected ? 'Warte auf neue Zeilen...' : 'Keine Daten'}</div>}
          <div ref={bottomRef} />
        </div>

        <div style={modal.footer}>
          {displayed.length} Zeilen{sources.length === 1 && sources[0].config?.path ? ` | ${sources[0].config.path}` : ''}
        </div>
      </div>
    </div>
  )
}

export default function EventsPage() {
  const { filter: globalFilter, setFilter: setGlobalFilter, selectedSources, setSelectedSources, customSources, setCustomSources } = useSourceFilter()
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
  const [tailSources, setTailSources] = useState<SourceResponse[] | null>(null)
  const [uploadResult, setUploadResult] = useState<UploadResultState | null>(null)
  const tableContainerRef = useRef<HTMLDivElement>(null)

  const { data: sources = [] } = useQuery({ queryKey: ['sources'], queryFn: getSources })
  // Live-Tail works for all selected file sources (1..n) – configured directly,
  // presets/custom paths are resolved against configured sources by path.
  const liveTailSources: SourceResponse[] = (() => {
    const result: SourceResponse[] = []
    const seen = new Set<string>()
    for (const sel of selectedSources) {
      let match: SourceResponse | undefined
      if (sel.kind === 'configured') {
        match = sources.find(s => s.id === sel.id.replace('source:', ''))
      } else if (sel.path) {
        match = sources.find(s => s.config?.path === sel.path)
      }
      if (match && match.type === 'file' && !seen.has(match.id)) {
        seen.add(match.id)
        result.push(match)
      }
    }
    return result
  })()
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

  const effectiveSourceIdCount = effectiveSourceIdsCsv ? effectiveSourceIdsCsv.split(',').filter(Boolean).length : 0
  const effectiveSourcePathCount = effectiveSourcePathsCsv ? effectiveSourcePathsCsv.split(',').filter(Boolean).length : 0
  const showSourceColumn = (effectiveSourceIdCount + effectiveSourcePathCount) > 1
  const sourceNameById = new Map<string, string>(sources.map(s => [s.id, s.name]))

  const selectedSeveritiesCsv = selectedSeverities.join(',')

  // Apply global rangeHours when no explicit from/to is set.
  // Memoized to keep query keys stable across re-renders.
  const rangeHours = globalFilter.rangeHours
  const effectiveWindow = useMemo(() => {
    if (fromTime || toTime) {
      return {
        from: fromTime || undefined,
        to: toTime || undefined,
      }
    }

    if (rangeHours <= 0) {
      return { from: undefined, to: undefined }
    }

    const now = Date.now()
    return {
      from: new Date(now - rangeHours * 3600_000).toISOString(),
      to: new Date(now).toISOString(),
    }
  }, [fromTime, toTime, rangeHours, refreshTick])
  const effectiveFrom = effectiveWindow.from
  const effectiveTo = effectiveWindow.to

  function handleRangeHoursChange(nextRangeHours: number) {
    setGlobalFilter({
      sourceIds: globalFilter.sourceIds,
      sourcePaths: globalFilter.sourcePaths,
      rangeHours: nextRangeHours,
    })
    // Clear any explicit from/to so the preset takes effect immediately.
    setFromTime('')
    setToTime('')
  }

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
  }, [globalSingleSourceId, globalSingleSourcePath, sourceId, sourceIdsCsv, sourcePathsCsv])

  // Infinite query: loads events page by page
  const { data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage, isFetching } = useInfiniteQuery({
    queryKey: ['events', sourceId, effectiveSourceIdsCsv, effectiveSourcePathsCsv, effectiveFrom, effectiveTo, selectedSeveritiesCsv, host, service, search, refreshTick],
    queryFn: ({ pageParam }: { pageParam?: string }) => getEvents({
      limit: 50,
      cursor: pageParam,
      ...(effectiveFrom ? { from: effectiveFrom } : {}),
      ...(effectiveTo ? { to: effectiveTo } : {}),
      ...(sourceId ? { source_id: sourceId } : {}),
      ...(effectiveSourceIdsCsv ? { source_ids: effectiveSourceIdsCsv } : {}),
      ...(effectiveSourcePathsCsv ? { source_paths: effectiveSourcePathsCsv } : {}),
      ...(selectedSeveritiesCsv ? { severity: selectedSeveritiesCsv } : {}),
      ...(host ? { host } : {}),
      ...(service ? { service } : {}),
      ...(search ? { q: search } : {}),
    }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    staleTime: 30_000,
  })

  // Flatten all pages into single events array
  const allEvents = data?.pages.flatMap(page => page.items) ?? []

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
    setCustomSources([])
  }

  function handleSourcePickerChange(nextSelected: SourceOption[]) {
    setSelectedSources(nextSelected)
    const nextSourceIds = nextSelected.filter(s => s.kind === 'configured').map(s => s.id.replace('source:', ''))
    const nextSourcePaths = nextSelected.filter(s => s.kind === 'preset' || s.kind === 'custom').map(s => s.path)
    setGlobalFilter({ sourceIds: nextSourceIds, sourcePaths: nextSourcePaths, rangeHours: globalFilter.rangeHours })
    setSourceId('')
    setSourceIdsCsv('')
    setSourcePathsCsv('')
  }

  function removeCustomSource(id: string) {
    setCustomSources(prev => prev.filter(s => s.id !== id))
    handleSourcePickerChange(selectedSources.filter(s => s.id !== id))
  }

  async function handleUploadResult(r: UploadResultState) {
    setUploadResult(r)
  }

  function toggleExpand(id: string) {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  }

  function refreshLatest() {
    setExpanded({})
    setRefreshTick(v => v + 1)
  }

  const hasFilters = sourceId || sourceIdsCsv || sourcePathsCsv || effectiveFrom || effectiveTo || selectedSeveritiesCsv || host || service || search
  const contextItems = buildContextItems({
    sourceId,
    sourceIdsCsv: effectiveSourceIdsCsv,
    sourcePathsCsv: effectiveSourcePathsCsv,
    fromTime: effectiveFrom ?? '',
    toTime: effectiveTo ?? '',
    severityCsv: selectedSeveritiesCsv,
    host,
    service,
    search,
    sources,
  })

  return (
    <div>
      {tailSources && <LiveTailModal sources={tailSources} onClose={() => setTailSources(null)} />}

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

      {uploadResult && (
        <div style={{ padding: '0.5rem 1rem', marginBottom: '0.5rem', borderRadius: 8, background: isUploadError(uploadResult) ? '#450a0a' : '#0f2d1a', color: isUploadError(uploadResult) ? '#f87171' : '#86efac', fontSize: '0.85rem', position: 'relative' }}>
          <button onClick={() => setUploadResult(null)} style={{ position: 'absolute', top: '0.4rem', right: '0.5rem', background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '1rem' }}>✕</button>
          {isUploadError(uploadResult) ? uploadResult.error : `Import abgeschlossen: ${uploadResult.events_created ?? 0} Events importiert.`}
        </div>
      )}

      <div style={styles.filters}>
        <SourcePicker
          selected={selectedSources}
          onChange={handleSourcePickerChange}
          onUploadResult={handleUploadResult}
          customSources={customSources}
          onRemoveCustom={removeCustomSource}
        />
        <HelpTip content="Wähle eine oder mehrere Quellen für die Eventliste. Die Auswahl steuert auch den globalen Kontext für den AI-Chat." ariaLabel="Quellenfilter erklaeren" />
        <button onClick={refreshLatest} disabled={isFetching} style={styles.refBtn}>
          {isFetching ? 'Refresh...' : 'Refresh'}
        </button>
        <button
          onClick={() => liveTailSources.length > 0 && setTailSources(liveTailSources)}
          disabled={liveTailSources.length === 0}
          style={liveTailSources.length === 0 ? styles.liveBtnDisabled : styles.liveBtn}
          title={
            liveTailSources.length === 0
              ? 'Mindestens eine Datei-Quelle auswaehlen'
              : liveTailSources.length === 1
                ? `Live-Ansicht fuer ${liveTailSources[0].name}`
                : `Live-Ansicht fuer ${liveTailSources.length} Quellen`
          }
        >
          {liveTailSources.length > 1 ? `Live-Ansicht (${liveTailSources.length})` : 'Live-Ansicht'}
        </button>
        <HelpTip content="Die Live-Ansicht streamt neue Zeilen aller gewaehlten Datei-Quellen direkt in ein Tail-Fenster. Damit pruefst du schnell, ob gerade frische Daten ankommen." ariaLabel="Live-Ansicht erklaeren" />

        <TimeRangePicker value={rangeHours} onChange={handleRangeHoursChange} />
        <HelpTip content="Das Zeitfenster gilt fuer Eventliste und Dashboard gleichzeitig. Aenderungen werden zwischen den Reitern synchronisiert." ariaLabel="Zeitfenster erklaeren" />

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
                }}
              >
                Alle
              </button>
              <button
                type="button"
                style={styles.severityActionBtn}
                onClick={() => {
                  setSelectedSeverities([])
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
          placeholder="Host filtern..."
          style={{ ...styles.search, flex: '0 0 140px' }}
        />
        <input
          value={service}
          onChange={e => setService(e.target.value)}
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
                {showSourceColumn && <span style={{ width: 140 }}>Quelle</span>}
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
                    {showSourceColumn && (
                      <span style={{ width: 140, color: '#7dd3fc', flexShrink: 0, fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={event.source_id ?? ''}>
                        {event.source_id ? (sourceNameById.get(event.source_id) ?? event.source_id.slice(0, 8)) : '-'}
                      </span>
                    )}
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
                        <span style={styles.detailLabel}>Quelle</span><span style={styles.detailVal}>{event.source_id ? `${sourceNameById.get(event.source_id) ?? event.source_id} (${event.source_id})` : '-'}</span>
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
