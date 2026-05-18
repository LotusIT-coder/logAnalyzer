import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getEvents, getSources, getServerTime, type EventResponse, type SourceResponse } from '../lib/requests'
import dayjs from 'dayjs'
import { getApiBase } from '../lib/api'
import HelpTip from '../components/HelpTip'
import GlobalSourceFilterNotice from '../components/GlobalSourceFilterNotice'
import { SourcePicker, type UploadResultState, isUploadError } from '../components/SourcePicker'
import { TimeRangePicker } from '../components/TimeRangePicker'
import { type SourceOption } from '../ctx/SourceFilterContext.shared'
import { useSourceFilter } from '../ctx/useSourceFilter'
import { AnsiText, FormattedMessage } from '../components/FormattedMessage'
import { useI18n } from '../ctx/I18nContext'

const SEV_COLOR: Record<string, string> = {
  critical: '#ef4444',
  error: '#f97316',
  warning: '#eab308',
  info: '#22c55e',
  debug: '#6366f1',
}

// Wenn true (Standard), zeigt die Eventseite nichts an, solange keine Quelle
// (per globalem Filter, Dropdown oder Pfad) ausgewaehlt ist. Per Build-Variable
// `VITE_EVENTS_REQUIRE_SOURCE_SELECTION=false` deaktivierbar, dann gilt
// wieder "kein Filter ⇒ alle Quellen anzeigen".
const REQUIRE_SOURCE_SELECTION =
  (import.meta.env.VITE_EVENTS_REQUIRE_SOURCE_SELECTION ?? 'true').toString().toLowerCase() !== 'false'

const SEVERITIES = ['debug', 'info', 'warning', 'error', 'critical']

function getEventObservedAt(event: EventResponse) {
  return event.created_at ?? event.timestamp
}

function parseSeverityCsv(value: string) {
  return value
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)
}

function normalizeProvider(value: string) {
  const lowered = value.trim().toLowerCase()
  if (lowered === 'postgres' || lowered === 'elastic') return lowered
  return ''
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

function parseCsvValues(value: string) {
  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
}

function buildContextItems(params: {
  sourceId: string
  sourceIdsCsv: string
  sourcePathsCsv: string
  fromTime: string
  toTime: string
  severityCsv: string
  provider: string
  host: string
  service: string
  search: string
  searchLabel: string
  sources: SourceResponse[]
}) {
  const items: string[] = []
  const source = params.sourceId ? params.sources.find(entry => entry.id === params.sourceId) : null
  const sourceIds = params.sourceIdsCsv ? params.sourceIdsCsv.split(',').map(value => value.trim()).filter(Boolean) : []
  const sourcePaths = params.sourcePathsCsv ? params.sourcePathsCsv.split(',').map(value => value.trim()).filter(Boolean) : []
  const rangeLabel = formatDateRange(params.fromTime, params.toTime)

  if (source) items.push(`Source: ${source.name}`)
  else if (params.sourceId) items.push(`Source: ${params.sourceId}`)
  if (sourceIds.length === 1) {
    const srcName = params.sources.find(s => s.id === sourceIds[0])?.name ?? sourceIds[0]
    items.push(`Source: ${srcName}`)
  } else if (sourceIds.length > 1) {
    items.push(`Sources: ${sourceIds.length}`)
    const names = sourceIds.map(id => params.sources.find(s => s.id === id)?.name ?? id)
    items.push(`Multi-select: ${names.join(', ')}`)
  }
  if (sourcePaths.length === 1) {
    items.push(`Path: ${sourcePaths[0].split('/').pop() ?? sourcePaths[0]}`)
  } else if (sourcePaths.length > 1) {
    items.push(`Paths: ${sourcePaths.length}`)
    const pathNames = sourcePaths.map(p => p.split('/').pop() ?? p)
    items.push(`Multi-select: ${pathNames.join(', ')}`)
  }
  if (rangeLabel) items.push(`Range: ${rangeLabel}`)
  if (params.severityCsv) {
    const labels = params.severityCsv.split(',').map(value => value.trim()).filter(Boolean)
    if (labels.length) items.push(`Severity: ${labels.join(', ')}`)
  }
  if (params.host) items.push(`Host: ${params.host}`)
  if (params.service) items.push(`Service: ${params.service}`)
  if (params.search) items.push(`${params.searchLabel}: ${params.search}`)
  if (params.provider) items.push(`Provider: ${params.provider}`)

  return items
}

interface TailLine {
  text: string
  sourceId: string
  sourceName: string
  seq: number
}

const SOURCE_COLORS = ['#7dd3fc', '#fbbf24', '#a78bfa', '#34d399', '#fb7185', '#60a5fa', '#f97316', '#c084fc']

const EVENTS_REFRESH_INTERVAL_KEY = 'events:refresh-interval-ms'
const REFRESH_INTERVAL_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Aus' },
  { value: 2_000, label: '2 s' },
  { value: 5_000, label: '5 s' },
  { value: 10_000, label: '10 s' },
  { value: 30_000, label: '30 s' },
  { value: 60_000, label: '1 min' },
  { value: 300_000, label: '5 min' },
]

const ANSI_LEGEND_ROWS: Array<{ sample: string; code: string; meaning: string }> = [
  { sample: 'var(--ansi-fg-31)', code: '31 / 91', meaning: 'Error, critical, failed' },
  { sample: 'var(--ansi-fg-32)', code: '32 / 92', meaning: 'Info, success, ingested' },
  { sample: 'var(--ansi-fg-33)', code: '33 / 93', meaning: 'Warning, hint, degraded' },
  { sample: 'var(--ansi-fg-34)', code: '34 / 94', meaning: 'Host, path, ID, source' },
  { sample: 'var(--ansi-fg-35)', code: '35 / 95', meaning: 'Counter, metrics, totals' },
  { sample: 'var(--ansi-fg-36)', code: '36 / 96', meaning: 'Flow, status, marker' },
  { sample: 'var(--ansi-fg-90)', code: '90', meaning: 'Dimmed / secondary' },
]

function LiveTailModal({ sources, onClose }: { sources: SourceResponse[]; onClose: () => void }) {
  const { t } = useI18n()
  const [lines, setLines] = useState<TailLine[]>([])
  const [connected, setConnected] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [paused, setPaused] = useState(false)
  const [alertFocusMode, setAlertFocusMode] = useState(true)
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
        setErrors(prev => ({ ...prev, [source.id]: t('events.livetail.connected.none') }))
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
  const errorList = Object.entries(errors)
    .filter(([id]) => sources.find(s => s.id === id))
    .reverse() // Show newest errors at the top
  const showSourceTag = sources.length > 1
  const title = sources.length === 1
    ? t('events.livetail.titleSingle', { name: sources[0].name })
    : t('events.livetail.titleMulti', { count: sources.length })

  function getLineColor(text: string) {
    const isError = /error|crit|fatal|emerg/i.test(text)
    const isWarning = /warn/i.test(text)
    const isDebug = /debug/i.test(text)

    if (isError) return 'var(--danger-fg)'
    if (isWarning) return 'var(--warning-fg)'
    if (alertFocusMode) return 'var(--fg)'
    if (isDebug) return 'var(--ansi-fg-35)'
    return 'var(--fg)'
  }

  return (
    <div style={modal.overlay} onClick={onClose}>
      <div style={modal.box} onClick={e => e.stopPropagation()}>
        <div style={modal.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>{title}</span>
            <span style={{ ...modal.dot, background: allConnected ? '#22c55e' : anyConnected ? '#fbbf24' : '#ef4444' }} />
            <span style={{ fontSize: '0.75rem', color: 'var(--muted-fg)' }}>
              {allConnected
                ? t('events.livetail.connected.all')
                : anyConnected
                  ? t('events.livetail.connected.partial', { connected: sources.filter(s => connected[s.id]).length, total: sources.length })
                  : t('events.livetail.connected.none')}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {showSourceTag && (
              <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} style={modal.filterInput}>
                <option value="">{t('events.livetail.allSources')}</option>
                {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={t('events.livetail.filterLines')}
              style={modal.filterInput}
            />
            <button
              onClick={() => setAlertFocusMode(v => !v)}
              style={alertFocusMode ? modal.ctrlBtnActive : modal.ctrlBtn}
              title={t('events.livetail.alertFocusHint')}
            >
              {alertFocusMode ? t('events.livetail.alertFocusOn') : t('events.livetail.alertFocusOff')}
            </button>
            <button onClick={() => setPaused(v => !v)} style={modal.ctrlBtn}>{paused ? t('events.livetail.resume') : t('events.livetail.pause')}</button>
            <button onClick={() => setLines([])} style={modal.ctrlBtn}>{t('events.livetail.clear')}</button>
            <button onClick={onClose} style={{ ...modal.ctrlBtn, color: 'var(--danger-fg)' }}>x {t('events.livetail.close')}</button>
          </div>
        </div>

        {showSourceTag && (
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', padding: '0.4rem 1rem', borderBottom: '1px solid var(--border)', fontSize: '0.72rem' }}>
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
          <div style={{ color: 'var(--danger-fg)', padding: '0.5rem 1rem', fontSize: '0.82rem' }}>
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
                color: getLineColor(line.text),
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
          {!displayed.length && <div style={{ color: 'var(--muted-fg)', padding: '1rem' }}>{anyConnected ? t('events.livetail.waiting') : t('events.livetail.noData')}</div>}
          <div ref={bottomRef} />
        </div>

        <div style={modal.footer}>
          {t('events.livetail.lines', { count: displayed.length })}{sources.length === 1 && sources[0].config?.path ? ` | ${sources[0].config.path}` : ''}
        </div>
      </div>
    </div>
  )
}

function ColorLegendModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  return (
    <div style={modal.overlay} onClick={onClose}>
      <div style={legendModal.box} onClick={e => e.stopPropagation()}>
        <div style={legendModal.header}>
          <div>
            <div style={legendModal.title}>{t('events.legend.title')}</div>
            <div style={legendModal.subtitle}>{t('events.legend.subtitle')}</div>
          </div>
          <button onClick={onClose} style={legendModal.closeBtn}>x {t('events.livetail.close')}</button>
        </div>

        <div style={legendModal.content}>
          <div style={legendModal.tableHeader}>
            <span style={{ width: 80 }}>{t('events.legend.color')}</span>
            <span style={{ width: 110 }}>ANSI Code</span>
            <span style={{ flex: 1 }}>{t('events.legend.meaning')}</span>
          </div>
          {ANSI_LEGEND_ROWS.map(row => (
            <div key={row.code} style={legendModal.tableRow}>
              <span style={{ width: 80, display: 'flex', alignItems: 'center' }}>
                <span style={{ ...legendModal.swatch, background: row.sample }} />
              </span>
              <span style={{ width: 110, color: 'var(--fg)', fontFamily: 'monospace' }}>{row.code}</span>
              <span style={{ flex: 1, color: 'var(--muted-fg)' }}>{row.meaning}</span>
            </div>
          ))}

          <div style={legendModal.note}>
            {t('events.legend.note')}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function EventsPage() {
  const { t } = useI18n()
  const { filter: globalFilter, setFilter: setGlobalFilter, selectedSources, setSelectedSources, customSources, setCustomSources } = useSourceFilter()
  const [searchParams] = useSearchParams()
  const [sourceId, setSourceId] = useState(() => getInitialFilterValue(searchParams, 'source_id'))
  const [sourceIdsCsv, setSourceIdsCsv] = useState(() => getInitialFilterValue(searchParams, 'source_ids'))
  const [sourcePathsCsv, setSourcePathsCsv] = useState(() => getInitialFilterValue(searchParams, 'source_paths'))
  const [fromTime, setFromTime] = useState(() => getInitialFilterValue(searchParams, 'from'))
  const [toTime, setToTime] = useState(() => getInitialFilterValue(searchParams, 'to'))
  const [selectedSeverities, setSelectedSeverities] = useState<string[]>(() => parseSeverityCsv(getInitialFilterValue(searchParams, 'severity')))
  const [provider, setProvider] = useState(() => normalizeProvider(getInitialFilterValue(searchParams, 'provider')))
  const [host, setHost] = useState(() => getInitialFilterValue(searchParams, 'host'))
  const [service, setService] = useState(() => getInitialFilterValue(searchParams, 'service'))
  const [search, setSearch] = useState(() => getInitialFilterValue(searchParams, 'q'))
  const [searchInput, setSearchInput] = useState(() => getInitialFilterValue(searchParams, 'q'))
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [tailSources, setTailSources] = useState<SourceResponse[] | null>(null)
  const [uploadResult, setUploadResult] = useState<UploadResultState | null>(null)
  const [showColorLegend, setShowColorLegend] = useState(false)
  const [serverTimeOffset, setServerTimeOffset] = useState<number>(0)
  const [refreshIntervalMs, setRefreshIntervalMs] = useState<number>(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(EVENTS_REFRESH_INTERVAL_KEY) : null
    const parsed = stored ? Number(stored) : NaN
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5_000
  })
  const tableContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(EVENTS_REFRESH_INTERVAL_KEY, String(refreshIntervalMs))
  }, [refreshIntervalMs])

  // Synchronize client time with server time to fix time-skew bugs
  // where events fall outside the filter range due to time differences
  useEffect(() => {
    const syncServerTime = async () => {
      try {
        const response = await getServerTime()
        const clientNowMs = Date.now()
        const serverNowMs = response.unix_ms
        const offset = serverNowMs - clientNowMs
        setServerTimeOffset(offset)
      } catch (error) {
        console.warn('Failed to sync server time:', error)
        // Gracefully fall back to client time (offset = 0)
        setServerTimeOffset(0)
      }
    }
    void syncServerTime()
  }, [])

  const { data: sources = [] } = useQuery({ queryKey: ['sources'], queryFn: getSources })
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
  const effectiveSourcePathsCsvRaw = sourcePathsCsv || (!sourceId ? globalSourcePathsCsv : '')
  const effectiveSourcePathsCsv = useMemo(() => {
    const explicitSourceIds = [
      ...(sourceId ? [sourceId] : []),
      ...parseCsvValues(effectiveSourceIdsCsv),
    ]
    if (explicitSourceIds.length === 0 || !effectiveSourcePathsCsvRaw) return effectiveSourcePathsCsvRaw

    const allowedPaths = new Set(
      explicitSourceIds
        .map(id => sources.find(source => source.id === id)?.config?.path)
        .filter((path): path is string => Boolean(path)),
    )

    return parseCsvValues(effectiveSourcePathsCsvRaw)
      .filter(path => allowedPaths.has(path))
      .join(',')
  }, [sourceId, effectiveSourceIdsCsv, effectiveSourcePathsCsvRaw, sources])

  useEffect(() => {
    if (!sourcePathsCsv || sourcePathsCsv === effectiveSourcePathsCsv) return
    setSourcePathsCsv(effectiveSourcePathsCsv)
  }, [sourcePathsCsv, effectiveSourcePathsCsv])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    const currentSourcePaths = url.searchParams.get('source_paths') ?? ''
    if (currentSourcePaths === effectiveSourcePathsCsv) return

    if (effectiveSourcePathsCsv) url.searchParams.set('source_paths', effectiveSourcePathsCsv)
    else url.searchParams.delete('source_paths')

    const nextUrl = `${url.pathname}${url.search}${url.hash}`
    window.history.replaceState(window.history.state, '', nextUrl)
  }, [effectiveSourcePathsCsv])

  const effectiveSourceIdCount = effectiveSourceIdsCsv ? effectiveSourceIdsCsv.split(',').filter(Boolean).length : 0
  const effectiveSourcePathCount = effectiveSourcePathsCsv ? effectiveSourcePathsCsv.split(',').filter(Boolean).length : 0
  const showSourceColumn = (effectiveSourceIdCount + effectiveSourcePathCount) > 1
  const sourceNameById = new Map<string, string>(sources.map(s => [s.id, s.name]))

  const selectedSeveritiesCsv = selectedSeverities.join(',')

  // Apply global rangeHours when no explicit from/to is set.
  // Keep key inputs stable; the actual live window is resolved in queryFn per fetch.
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

    // Use server-synchronized time instead of client Date.now()
    const now = Date.now() + serverTimeOffset
    return {
      from: new Date(now - rangeHours * 3600_000).toISOString(),
      to: new Date(now).toISOString(),
    }
  }, [fromTime, toTime, rangeHours, serverTimeOffset])
  const effectiveFrom = effectiveWindow.from
  const effectiveTo = effectiveWindow.to

  function resolveQueryWindow() {
    if (fromTime || toTime) {
      return {
        from: fromTime || undefined,
        to: toTime || undefined,
      }
    }
    if (rangeHours <= 0) return { from: undefined, to: undefined }
    // Use server-synchronized time instead of client Date.now()
    // to ensure events don't fall outside filter ranges due to time skew
    const now = Date.now() + serverTimeOffset
    return {
      from: new Date(now - rangeHours * 3600_000).toISOString(),
      to: new Date(now).toISOString(),
    }
  }

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

  useEffect(() => {
    const openLegend = () => setShowColorLegend(true)
    window.addEventListener('events:open-color-legend', openLegend)
    return () => window.removeEventListener('events:open-color-legend', openLegend)
  }, [])

  // Infinite query: loads events page by page
  const hasAnySourceSelection = Boolean(sourceId || effectiveSourceIdsCsv || effectiveSourcePathsCsv)
  const eventsQueryEnabled = !REQUIRE_SOURCE_SELECTION || hasAnySourceSelection
  const { data, isLoading, isFetched, hasNextPage, fetchNextPage, isFetchingNextPage, isFetching, refetch } = useInfiniteQuery({
    queryKey: ['events', sourceId, effectiveSourceIdsCsv, effectiveSourcePathsCsv, fromTime, toTime, rangeHours, selectedSeveritiesCsv, provider, host, service, search],
    queryFn: ({ pageParam }: { pageParam?: string }) => {
      const queryWindow = resolveQueryWindow()
      return getEvents({
      limit: 50,
      cursor: pageParam,
      ...(queryWindow.from ? { from: queryWindow.from } : {}),
      ...(queryWindow.to ? { to: queryWindow.to } : {}),
      ...(sourceId ? { source_id: sourceId } : {}),
      ...(effectiveSourceIdsCsv ? { source_ids: effectiveSourceIdsCsv } : {}),
      ...(effectiveSourcePathsCsv ? { source_paths: effectiveSourcePathsCsv } : {}),
      ...(selectedSeveritiesCsv ? { severity: selectedSeveritiesCsv } : {}),
      ...(provider ? { provider } : {}),
      ...(host ? { host } : {}),
      ...(service ? { service } : {}),
      ...(search ? { q: search } : {}),
      })
    },
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
      staleTime: 0,
    refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    refetchIntervalInBackground: true,
    enabled: eventsQueryEnabled,
  })

  // Flatten all pages into single events array
  const allEvents = eventsQueryEnabled ? (data?.pages.flatMap(page => page.items) ?? []) : []
  const showInitialLoading = isLoading && !isFetched

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
    setProvider('')
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
    void refetch()
  }

  const hasFilters = sourceId || sourceIdsCsv || sourcePathsCsv || effectiveFrom || effectiveTo || selectedSeveritiesCsv || host || service || search
  const contextItems = buildContextItems({
    sourceId,
    sourceIdsCsv: effectiveSourceIdsCsv,
    sourcePathsCsv: effectiveSourcePathsCsv,
    fromTime: effectiveFrom ?? '',
    toTime: effectiveTo ?? '',
    severityCsv: selectedSeveritiesCsv,
    provider,
    host,
    service,
    search,
    searchLabel: t('events.context.searchLabel'),
    sources,
  })

  return (
    <div>
      {tailSources && <LiveTailModal sources={tailSources} onClose={() => setTailSources(null)} />}
      {showColorLegend && <ColorLegendModal onClose={() => setShowColorLegend(false)} />}

      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <h2 style={styles.h2}>Events</h2>
          <HelpTip content="The event list shows raw events with all active filters. Click a row to open detailed event fields." ariaLabel="Explain events" />
        </div>
        <button onClick={refreshLatest} disabled={isFetching} style={styles.refBtn}>
          {isFetching ? t('events.refreshing') : t('events.refresh')}
        </button>
      </div>

      {showGlobalFilterNotice && <GlobalSourceFilterNotice />}

      {uploadResult && (
        <div style={{ padding: '0.5rem 1rem', marginBottom: '0.5rem', borderRadius: 8, background: isUploadError(uploadResult) ? 'color-mix(in srgb, var(--danger-fg) 16%, var(--surface))' : 'color-mix(in srgb, var(--success-fg) 16%, var(--surface))', color: isUploadError(uploadResult) ? 'var(--danger-fg)' : 'var(--success-fg)', fontSize: '0.85rem', position: 'relative', border: '1px solid var(--border)' }}>
          <button onClick={() => setUploadResult(null)} style={{ position: 'absolute', top: '0.4rem', right: '0.5rem', background: 'none', border: 'none', color: 'var(--muted-fg)', cursor: 'pointer', fontSize: '1rem' }}>✕</button>
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
        <HelpTip content="Choose one or more sources for the event list. This selection also controls the global context for AI chat." ariaLabel="Explain source filter" />
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <span style={{ color: 'var(--muted-fg)', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{t('events.live')}</span>
          <select
            value={String(refreshIntervalMs)}
            onChange={e => setRefreshIntervalMs(Number(e.target.value))}
            style={styles.intervalSelect}
            aria-label="Refresh interval"
          >
            {REFRESH_INTERVAL_OPTIONS.map(opt => (
              <option key={opt.value} value={String(opt.value)}>{opt.label}</option>
            ))}
          </select>
          <HelpTip content="The event list refreshes automatically with the selected interval and current filters. 'Off' pauses live updates." ariaLabel="Explain live refresh" />
        </div>

        <TimeRangePicker value={rangeHours} onChange={handleRangeHoursChange} />
        <HelpTip content="The time window is shared by Events and Dashboard. Changes stay synchronized between tabs." ariaLabel="Explain time window" />

        <details style={styles.severityDropdown}>
          <summary style={styles.severitySummary}>
            {selectedSeverities.length > 0
              ? t('events.severity.selected', { count: selectedSeverities.length })
              : t('events.severity.all')}
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
                {t('events.severity.allButton')}
              </button>
              <button
                type="button"
                style={styles.severityActionBtn}
                onClick={() => {
                  setSelectedSeverities([])
                }}
              >
                {t('events.severity.noneButton')}
              </button>
            </div>
          </div>
        </details>
        <HelpTip content="Severities help with prioritization. Error and critical events often need immediate action, while info and debug events usually add context." ariaLabel="Explain severity filter" />
        <select
          value={provider}
          onChange={e => setProvider(normalizeProvider(e.target.value))}
          style={{ ...styles.select, minWidth: 170 }}
          aria-label="Event-Provider"
          title="Diagnose-Provider fuer die Event-Suche"
        >
          <option value="">{t('events.provider.auto')}</option>
          <option value="postgres">{t('events.provider.postgres')}</option>
          <option value="elastic">{t('events.provider.elastic')}</option>
        </select>
        <span style={styles.providerHint}>
          {provider === 'postgres'
            ? t('events.provider.postgresHint')
            : provider === 'elastic'
              ? t('events.provider.elasticHint')
              : t('events.provider.autoHint')}
        </span>
        <input
          value={host}
          onChange={e => setHost(e.target.value)}
          placeholder={t('events.filterHost')}
          style={{ ...styles.search, flex: '0 0 140px' }}
        />
        <input
          value={service}
          onChange={e => setService(e.target.value)}
          placeholder={t('events.filterService')}
          style={{ ...styles.search, flex: '0 0 140px' }}
        />
        <input
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && applySearch()}
          placeholder={t('events.searchMessage')}
          style={styles.search}
        />
        <HelpTip content="Text search scans the event message, while host and service fields filter structured metadata." ariaLabel="Explain text search" />
        <button onClick={applySearch} style={styles.btn}>{t('events.search')}</button>
        {hasFilters && (
          <button onClick={resetFilters} style={styles.resetBtn}>{t('events.resetFilters')}</button>
        )}
      </div>

      {contextItems.length > 0 && (
        <div aria-label="Aktiver Kontext" style={styles.contextBar}>
          <span style={styles.contextLabel}>{t('events.context.active')}</span>
          <HelpTip content="These chips show which source, time, and content filters are currently active." ariaLabel="Explain active context" />
          {contextItems.map(item => (
            <span key={item} style={styles.contextChip}>{item}</span>
          ))}
        </div>
      )}

      <>
        <div style={styles.resultsMeta}>
          <span>{t('events.results.loaded', { count: allEvents.length })}</span>
          {hasNextPage && <span style={{ color: 'var(--muted-fg)' }}>↓ {t('events.results.scrollMore')}</span>}
          <HelpTip content="Events are sorted by receive time (newest first). The original log timestamp remains visible in details. Scroll down to load more and click rows to expand." ariaLabel="Explain event list" />
        </div>
        <div ref={tableContainerRef} style={styles.tableContainer}>
          <div style={styles.table}>
            <div style={styles.theader}>
              <span style={{ width: 150 }}>{t('events.table.received')}</span>
              <span style={{ width: 75 }}>Severity</span>
              {showSourceColumn && <span style={{ width: 140 }}>{t('events.table.source')}</span>}
              <span style={{ width: 110 }}>Host</span>
              <span style={{ width: 120 }}>Service</span>
              <span style={{ flex: 1 }}>{t('events.table.message')}</span>
            </div>
            {allEvents.map((event: EventResponse) => (
              <div key={event.id}>
                <div
                  style={{ ...styles.row, cursor: 'pointer', background: expanded[event.id] ? 'var(--table-row-alt-bg)' : undefined }}
                  onClick={() => toggleExpand(event.id)}
                  title={t('events.row.expand')}
                >
                  <span style={{ width: 150, color: 'var(--muted-fg)', flexShrink: 0, fontSize: '0.78rem' }}>
                    {dayjs(getEventObservedAt(event)).format('DD.MM.YY HH:mm:ss')}
                  </span>
                  <span style={{ width: 75, flexShrink: 0 }}>
                    <span style={{ ...styles.badge, background: SEV_COLOR[event.severity] ?? '#475569' }}>
                      {event.severity}
                    </span>
                  </span>
                  {showSourceColumn && (
                    <span style={{ width: 140, color: 'var(--accent)', flexShrink: 0, fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={event.source_id ?? ''}>
                      {event.source_id ? (sourceNameById.get(event.source_id) ?? event.source_id.slice(0, 8)) : '-'}
                    </span>
                  )}
                  <span style={{ width: 110, color: 'var(--muted-fg)', flexShrink: 0, fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {event.host ?? '-'}
                  </span>
                  <span style={{ width: 120, color: 'var(--muted-fg)', flexShrink: 0, fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {event.service ?? '-'}
                  </span>
                  <span style={{ flex: 1, overflow: 'hidden', fontSize: '0.84rem', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', lineHeight: '1.4' }}>
                    <AnsiText message={event.message} inline />
                  </span>
                </div>
                {expanded[event.id] && (
                  <div style={styles.detail}>
                    <div style={styles.detailGrid}>
                      <span style={styles.detailLabel}>ID</span><span style={styles.detailVal}>{event.id}</span>
                      <span style={styles.detailLabel}>{t('events.table.source')}</span><span style={styles.detailVal}>{event.source_id ? `${sourceNameById.get(event.source_id) ?? event.source_id} (${event.source_id})` : '-'}</span>
                      <span style={styles.detailLabel}>Empfangen</span><span style={styles.detailVal}>{dayjs(getEventObservedAt(event)).format('DD.MM.YYYY HH:mm:ss.SSS')}</span>
                      <span style={styles.detailLabel}>{t('events.detail.logTimestamp')}</span><span style={styles.detailVal}>{dayjs(event.timestamp).format('DD.MM.YYYY HH:mm:ss.SSS')}</span>
                      <span style={styles.detailLabel}>Host</span><span style={styles.detailVal}>{event.host ?? '-'}</span>
                      <span style={styles.detailLabel}>Service</span><span style={styles.detailVal}>{event.service ?? '-'}</span>
                      <span style={styles.detailLabel}>Severity</span><span style={styles.detailVal}>{event.severity}</span>
                    </div>
                    <div style={{ marginTop: '0.5rem' }}>
                      <span style={styles.detailLabel}>{t('events.detail.message')}:</span>
                      <div style={{ marginTop: '0.25rem' }}>
                        <FormattedMessage message={event.message} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {!allEvents.length && (
              <div style={{ padding: '2rem', color: 'var(--muted-fg)', textAlign: 'center' }}>
                {showInitialLoading
                  ? t('events.empty.loading')
                  : REQUIRE_SOURCE_SELECTION && !hasAnySourceSelection
                    ? t('events.empty.noSource')
                    : t('events.empty.noEvents')}
              </div>
            )}
            {isFetchingNextPage && (
              <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--muted-fg)', fontSize: '0.85rem' }}>
                {t('events.loadingMore')}
              </div>
            )}
          </div>
        </div>
      </>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' },
  h2: { margin: 0, fontSize: '1.5rem' },
  refBtn: { background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted-fg)', borderRadius: 6, padding: '0.35rem 0.75rem', cursor: 'pointer', opacity: 1 },
  intervalSelect: { background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.35rem 0.55rem', fontSize: '0.82rem' },
  liveBtn: { background: 'var(--nav-active-bg)', border: '1px solid var(--accent)', color: 'var(--nav-active-fg)', borderRadius: 6, padding: '0.4rem 0.9rem', cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' },
  liveBtnDisabled: { background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--muted-fg)', borderRadius: 6, padding: '0.4rem 0.9rem', cursor: 'not-allowed', fontWeight: 700, whiteSpace: 'nowrap' },
  filters: { display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' },
  contextBar: {
    display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem',
    background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 10, padding: '0.75rem 0.9rem',
  },
  contextLabel: { color: 'var(--muted-fg)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.08em' },
  contextChip: { background: 'var(--accent-soft)', color: 'var(--accent-fg)', borderRadius: 999, padding: '0.2rem 0.65rem', fontSize: '0.82rem' },
  resultsMeta: { display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem', color: 'var(--muted-fg)', marginBottom: '0.5rem' },
  select: { background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.4rem 0.6rem' },
  severityDropdown: { position: 'relative' },
  severitySummary: {
    background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6,
    padding: '0.4rem 0.6rem', listStyle: 'none', cursor: 'pointer', minWidth: 160,
  },
  severityMenu: {
    position: 'absolute', top: 'calc(100% + 0.3rem)', left: 0, zIndex: 30,
    minWidth: 180, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
    padding: '0.45rem 0.55rem', boxShadow: '0 10px 24px rgba(2, 6, 23, 0.5)',
  },
  severityOption: {
    display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--fg)',
    fontSize: '0.84rem', padding: '0.18rem 0',
  },
  severityActionBtn: {
    background: 'var(--surface-2)', color: 'var(--accent)', border: '1px solid var(--border)', borderRadius: 6,
    padding: '0.2rem 0.5rem', fontSize: '0.75rem', cursor: 'pointer',
  },
  providerHint: {
    color: 'var(--muted-fg)',
    fontSize: '0.76rem',
    whiteSpace: 'nowrap',
  },
  search: { flex: 1, minWidth: 120, background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.4rem 0.75rem' },
  btn: { background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '0.4rem 0.9rem', cursor: 'pointer', whiteSpace: 'nowrap' },
  resetBtn: { background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted-fg)', borderRadius: 6, padding: '0.4rem 0.9rem', cursor: 'pointer', whiteSpace: 'nowrap' },
  tableContainer: {
    maxHeight: 'calc(100vh - 450px)',
    overflowY: 'auto' as const,
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: 'var(--table-row-bg)',
  },
  table: { background: 'var(--table-row-bg)', borderRadius: 10, border: '1px solid var(--border)', overflow: 'hidden' },
  theader: {
    display: 'flex', gap: '1rem', padding: '0.6rem 1rem',
    background: 'var(--table-head-bg)', color: 'var(--muted-fg)', fontSize: '0.73rem', fontWeight: 700, textTransform: 'uppercase',
    position: 'sticky' as const,
    top: 0,
    zIndex: 10,
  },
  row: {
    display: 'flex', gap: '1rem', padding: '0.5rem 1rem',
    borderTop: '1px solid var(--border)', alignItems: 'center',
  },
  badge: {
    display: 'inline-block', borderRadius: 4, padding: '0 0.4rem',
    fontSize: '0.7rem', fontWeight: 700, color: '#fff',
  },
  pagination: { display: 'flex', gap: '0.75rem', marginTop: '1rem', justifyContent: 'flex-end' },
  detail: {
    background: 'var(--surface-2)', borderTop: '1px solid var(--border)',
    padding: '0.75rem 1rem 0.75rem 2rem', fontSize: '0.82rem',
  },
  detailGrid: {
    display: 'grid', gridTemplateColumns: '100px 1fr',
    gap: '0.25rem 0.75rem',
  },
  detailLabel: { color: 'var(--muted-fg)', fontWeight: 700 },
  detailVal: { color: 'var(--fg)', fontFamily: 'monospace' },
  detailPre: {
    margin: '0.25rem 0 0', padding: '0.5rem', background: 'var(--surface)',
    borderRadius: 6, color: 'var(--fg)', fontFamily: 'monospace',
    fontSize: '0.78rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
  },
}

const modal: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  box: {
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
    width: '90vw', maxWidth: 1100, height: '80vh',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', gap: '0.5rem',
  },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0, display: 'inline-block' },
  filterInput: {
    background: 'var(--surface-2)', color: 'var(--fg)', border: '1px solid var(--border)',
    borderRadius: 6, padding: '0.3rem 0.65rem', fontSize: '0.82rem', width: 200,
  },
  ctrlBtn: {
    background: 'var(--surface-2)', color: 'var(--muted-fg)', border: '1px solid var(--border)',
    borderRadius: 6, padding: '0.3rem 0.65rem', cursor: 'pointer', fontSize: '0.82rem',
  },
  ctrlBtnActive: {
    background: 'var(--accent-soft)', color: 'var(--accent-fg)', border: '1px solid var(--accent)',
    borderRadius: 6, padding: '0.3rem 0.65rem', cursor: 'pointer', fontSize: '0.82rem',
  },
  log: {
    flex: 1, overflowY: 'auto', padding: '0.5rem 1rem',
    fontFamily: 'monospace', fontSize: '0.78rem', lineHeight: 1.5,
  },
  logLine: { padding: '0.08rem 0', borderBottom: '1px solid var(--border)', wordBreak: 'break-all' },
  footer: {
    padding: '0.4rem 1rem', borderTop: '1px solid var(--border)',
    fontSize: '0.72rem', color: 'var(--muted-fg)',
  },
}

const legendModal: Record<string, React.CSSProperties> = {
  box: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    width: 'min(760px, 92vw)',
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '1rem',
    padding: '0.9rem 1rem',
    borderBottom: '1px solid var(--border)',
  },
  title: { fontWeight: 800, fontSize: '1rem', color: 'var(--fg)' },
  subtitle: { marginTop: '0.3rem', color: 'var(--muted-fg)', fontSize: '0.84rem', lineHeight: 1.4 },
  closeBtn: {
    background: 'var(--surface-2)',
    color: 'var(--muted-fg)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '0.3rem 0.65rem',
    cursor: 'pointer',
    fontSize: '0.82rem',
    whiteSpace: 'nowrap',
  },
  content: {
    padding: '0.75rem 1rem 1rem',
    overflowY: 'auto',
  },
  tableHeader: {
    display: 'flex',
    gap: '0.6rem',
    color: 'var(--muted-fg)',
    fontSize: '0.74rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    padding: '0.25rem 0.4rem',
    borderBottom: '1px solid var(--border)',
  },
  tableRow: {
    display: 'flex',
    gap: '0.6rem',
    alignItems: 'center',
    padding: '0.5rem 0.4rem',
    borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)',
    fontSize: '0.84rem',
  },
  swatch: {
    width: 22,
    height: 12,
    borderRadius: 999,
    border: '1px solid color-mix(in srgb, var(--fg) 22%, transparent)',
    display: 'inline-block',
  },
  note: {
    marginTop: '0.9rem',
    padding: '0.65rem 0.75rem',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-2)',
    color: 'var(--muted-fg)',
    fontSize: '0.8rem',
    lineHeight: 1.45,
  },
}
