import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  getErrorRate,
  getSourceIngestionStatus,
  getTimeseries,
  getTopErrors,
  getTopServices,
  runIngestion,
  type MetricsFilter,
  type SourceIngestionStatus,
  type TimeRange,
  type TimeseriesResponse,
  type TopErrorItem,
  type TopServiceItem,
} from '../lib/requests'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { getApiErrorMessage } from '../lib/errors'
import HelpTip from '../components/HelpTip'
import { SourcePicker, type UploadResultState, isUploadError } from '../components/SourcePicker'
import { TimeRangePicker, TIME_PRESETS } from '../components/TimeRangePicker'
import { type SourceOption } from '../ctx/SourceFilterContext.shared'
import { useSourceFilter } from '../ctx/useSourceFilter'

// ─── Time range presets ───────────────────────────────────────────────────────
// (TIME_PRESETS comes from the shared TimeRangePicker module.)

const CHART_BUCKETS: { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: '5s', label: '5 s' },
  { value: '15s', label: '15 s' },
  { value: '30s', label: '30 s' },
  { value: '1m', label: '1 m' },
  { value: '5m', label: '5 m' },
  { value: '15m', label: '15 m' },
  { value: '1h', label: '1 h' },
]

function chartBucketToMs(bucket: string) {
  const seconds: Record<string, number> = {
    auto: 0,
    '5s': 5,
    '15s': 15,
    '30s': 30,
    '1m': 60,
    '5m': 5 * 60,
    '15m': 15 * 60,
    '1h': 60 * 60,
  }
  return (seconds[bucket] ?? 15) * 1000
}

function resolveAutoRefreshMs(totalEvents: number, rangeHours: number, targetEventsPerRefresh: number) {
  const windowHours = rangeHours > 0 ? rangeHours : 24
  const clampedTotalEvents = Math.max(totalEvents, 0)
  const clampedTargetEvents = Math.max(targetEventsPerRefresh, 1)

  const eventsPerHour = clampedTotalEvents / windowHours

  if (eventsPerHour <= 0) return 24 * 60 * 60 * 1000

  const ms = (clampedTargetEvents / eventsPerHour) * 60 * 60 * 1000
  return Math.max(5_000, Math.min(ms, 24 * 60 * 60 * 1000))
}

function resolveChartBucket(rangeHours: number) {
  if (rangeHours === 0 || rangeHours > 168) return '1h'
  if (rangeHours > 24) return '15m'
  if (rangeHours > 6) return '1m'
  if (rangeHours > 1) return '15s'
  return '5s'
}

const AUTO_REFRESH_TARGET_EVENTS_KEY = 'dashboard:auto-refresh-target-events'
const AUTO_REFRESH_PROFILE_KEY = 'dashboard:auto-refresh-profile'
const DEFAULT_AUTO_REFRESH_TARGET_EVENTS = 5

type AutoRefreshProfile = 'conservative' | 'balanced' | 'aggressive'

const AUTO_REFRESH_PROFILES: { value: AutoRefreshProfile; label: string; targetEvents: number }[] = [
  { value: 'conservative', label: 'Ruhig', targetEvents: 20 },
  { value: 'balanced', label: 'Normal', targetEvents: 5 },
  { value: 'aggressive', label: 'Schnell', targetEvents: 1 },
]

function resolveAutoRefreshProfileFromTarget(targetEvents: number): AutoRefreshProfile {
  if (targetEvents >= 12) return 'conservative'
  if (targetEvents <= 2) return 'aggressive'
  return 'balanced'
}

function resolveAutoRefreshTargetEvents(profile: AutoRefreshProfile) {
  return AUTO_REFRESH_PROFILES.find(item => item.value === profile)?.targetEvents ?? DEFAULT_AUTO_REFRESH_TARGET_EVENTS
}

function formatAgeLabel(updatedAt?: number) {
  if (!updatedAt) return 'wird geladen...'
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000))
  if (elapsedSeconds < 5) return 'gerade eben'
  if (elapsedSeconds < 60) return `vor ${elapsedSeconds}s`
  const minutes = Math.floor(elapsedSeconds / 60)
  if (minutes < 60) return `vor ${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `vor ${hours} h`
}

function buildTimeRange(rangeHours: number): TimeRange | undefined {
  if (rangeHours === 0) return undefined
  const now = new Date()
  return {
    from: new Date(now.getTime() - rangeHours * 3600_000).toISOString(),
    to: now.toISOString(),
  }
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { filter, setFilter: setGlobalSourceFilter, selectedSources, setSelectedSources, customSources, setCustomSources } = useSourceFilter()
  // Single source of truth: global filter.rangeHours. Changes from any tab
  // propagate via context so this page stays in sync.
  const rangeHours = filter.rangeHours
  const [chartBucketMode, setChartBucketMode] = useState('auto')
  const [autoRefreshProfile, setAutoRefreshProfile] = useState<AutoRefreshProfile>(() => {
    if (typeof window === 'undefined') return 'balanced'
    const storedProfile = window.localStorage.getItem(AUTO_REFRESH_PROFILE_KEY)
    if (storedProfile === 'conservative' || storedProfile === 'balanced' || storedProfile === 'aggressive') {
      return storedProfile
    }
    const storedTarget = Number(window.localStorage.getItem(AUTO_REFRESH_TARGET_EVENTS_KEY))
    if (Number.isFinite(storedTarget) && storedTarget > 0) {
      return resolveAutoRefreshProfileFromTarget(storedTarget)
    }
    return 'balanced'
  })
  const autoRefreshTargetEvents = resolveAutoRefreshTargetEvents(autoRefreshProfile)
  const [ingesting, setIngesting] = useState(false)
  const [ingestError, setIngestError] = useState<string | null>(null)
  const [uploadResult, setUploadResult] = useState<UploadResultState | null>(null)
  const [topErrorsSeverities, setTopErrorsSeverities] = useState<string[]>(['error', 'critical'])

  useEffect(() => {
    window.localStorage.setItem(AUTO_REFRESH_PROFILE_KEY, autoRefreshProfile)
    window.localStorage.setItem(AUTO_REFRESH_TARGET_EVENTS_KEY, String(autoRefreshTargetEvents))
  }, [autoRefreshProfile, autoRefreshTargetEvents])

  function syncGlobalFilter(nextSelectedSources: SourceOption[], nextRangeHours = rangeHours) {
    const nextSelectedSourceIds = nextSelectedSources
      .filter(source => source.kind === 'configured')
      .map(source => source.id.replace('source:', ''))
    const nextSelectedSourcePaths = nextSelectedSources
      .filter(source => source.kind === 'preset' || source.kind === 'custom')
      .map(source => source.path)

    setGlobalSourceFilter({
      sourceIds: nextSelectedSourceIds,
      sourcePaths: nextSelectedSourcePaths,
      rangeHours: nextRangeHours,
    })
  }

  async function handleIngest(activeSources: SourceOption[]) {
    const activeSourceIds = activeSources
      .filter(source => source.kind === 'configured')
      .map(source => source.id.replace('source:', ''))

    setIngesting(true)
    setIngestError(null)
    try {
      await runIngestion({
        sourceIds: activeSourceIds,
        extraEntries: activeSources
          .filter(source => source.kind === 'preset' || source.kind === 'custom')
          .map(source => ({ path: source.path, origin: source.kind === 'preset' ? 'preset' as const : 'custom' as const })),
      })
      refetchAll()
    } catch (error: unknown) {
      setIngestError(getApiErrorMessage(error, 'Ingestion fehlgeschlagen.'))
    } finally {
      setIngesting(false)
    }
  }

  function handleSelectedSourcesChange(nextSelected: SourceOption[] | ((prev: SourceOption[]) => SourceOption[])) {
    const resolvedSelectedSources = typeof nextSelected === 'function' ? nextSelected(selectedSources) : nextSelected
    setSelectedSources(resolvedSelectedSources)
    syncGlobalFilter(resolvedSelectedSources)
    if (resolvedSelectedSources.length === 0) return
    void handleIngest(resolvedSelectedSources)
  }

  function handleRangeHoursChange(nextRangeHours: number) {
    syncGlobalFilter(selectedSources, nextRangeHours)
  }

  function removeCustomSource(id: string) {
    setCustomSources(prev => prev.filter(s => s.id !== id))
    handleSelectedSourcesChange(prev => prev.filter(s => s.id !== id))
  }

  const selectedSourceIds = selectedSources
    .filter(s => s.kind === 'configured')
    .map(s => s.id.replace('source:', ''))
  const selectedSourcePaths = selectedSources
    .filter(s => s.kind === 'preset' || s.kind === 'custom')
    .map(s => s.path)
  const metricsFilter: MetricsFilter | undefined = selectedSources.length > 0
    ? { sourceIds: selectedSourceIds, sourcePaths: selectedSourcePaths, severities: topErrorsSeverities }
    : undefined

  const sourceKey = `${selectedSourceIds.join('|')}::${selectedSourcePaths.join('|')}`

  const chartBucket = chartBucketMode === 'auto' ? resolveChartBucket(rangeHours) : chartBucketMode

  const rate = useQuery({
    queryKey: ['error-rate', rangeHours, sourceKey],
    queryFn: () => getErrorRate(buildTimeRange(rangeHours), metricsFilter),
    enabled: selectedSources.length > 0,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    refetchInterval: query => {
      if (chartBucketMode !== 'auto') return false
      const currentData = query.state.data as { total_events?: number } | undefined
      const totalEvents = currentData?.total_events ?? 0
      return totalEvents > 0
        ? resolveAutoRefreshMs(totalEvents, rangeHours, autoRefreshTargetEvents)
        : 15_000
    },
    refetchIntervalInBackground: true,
  })

  const ts = useQuery({
    queryKey: ['timeseries', rangeHours, sourceKey, chartBucketMode, chartBucket, autoRefreshTargetEvents],
    queryFn: () => {
      const timeRange = buildTimeRange(rangeHours)
      return getTimeseries({
        bucket: chartBucket,
        ...(timeRange ? { from: timeRange.from, to: timeRange.to } : {}),
        ...(metricsFilter?.sourceIds?.length ? { source_ids: metricsFilter.sourceIds.join(',') } : {}),
        ...(metricsFilter?.sourcePaths?.length ? { source_paths: metricsFilter.sourcePaths.join(',') } : {}),
      })
    },
    enabled: selectedSources.length > 0,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
    retry: 1,
    refetchInterval: query => {
      if (chartBucketMode !== 'auto') return chartBucketToMs(chartBucket)
      const currentData = query.state.data as TimeseriesResponse | undefined
      const totalEvents = currentData?.points.reduce((sum, point) => sum + point.count, 0) ?? 0
      return totalEvents > 0
        ? resolveAutoRefreshMs(totalEvents, rangeHours, autoRefreshTargetEvents)
        : 15_000
    },
    refetchIntervalInBackground: true,
  })

  const drilldownRefreshMs = chartBucketMode === 'auto'
    ? 15_000
    : Math.max(chartBucketToMs(chartBucket), 15_000)

  const errs = useQuery({
    queryKey: ['top-errors', rangeHours, sourceKey, topErrorsSeverities.join(',')],
    queryFn: () => getTopErrors(buildTimeRange(rangeHours), metricsFilter),
    enabled: selectedSources.length > 0 && topErrorsSeverities.length > 0,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    refetchInterval: drilldownRefreshMs,
    refetchIntervalInBackground: true,
  })
  const svcs = useQuery({
    queryKey: ['top-services', rangeHours, sourceKey],
    queryFn: () => getTopServices(buildTimeRange(rangeHours), metricsFilter),
    enabled: selectedSources.length > 0,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    refetchInterval: drilldownRefreshMs,
    refetchIntervalInBackground: true,
  })

  const sourceStatus = useQuery({
    queryKey: ['source-status', selectedSourceIds.join('|')],
    queryFn: () => getSourceIngestionStatus(selectedSourceIds),
    enabled: selectedSourceIds.length > 0,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  })

  function refetchAll() { ts.refetch(); errs.refetch(); svcs.refetch(); rate.refetch(); sourceStatus.refetch() }

  function handleUploadResult(result: UploadResultState) {
    setUploadResult(result)
    if (!isUploadError(result) && result.stored_path) {
      const opt: SourceOption = {
        id: `custom:${result.stored_path}`,
        label: result.source_name ?? result.stored_path.split('/').pop() ?? result.stored_path,
        path: result.stored_path,
        kind: 'custom',
      }
      setCustomSources(prev => prev.find(s => s.id === opt.id) ? prev : [...prev, opt])
      handleSelectedSourcesChange(prev => prev.find(s => s.id === opt.id) ? prev : [...prev, opt])
    }
  }

  const rr = rate.data
  const errorRate = rr ? (rr.total_events > 0 ? (rr.error_rate * 100).toFixed(1) : '0.0') : '–'
  const totalEvents = rr?.total_events ?? '–'
  const sourceStatusById = new Map<string, SourceIngestionStatus>((sourceStatus.data ?? []).map(entry => [entry.source_id, entry]))
  const [clockTick, setClockTick] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick(prev => (prev + 1) % 3600), 1000)
    return () => window.clearInterval(timer)
  }, [])

  void clockTick

  function sourceStatusTone(status?: SourceIngestionStatus) {
    if (!status?.last_event_timestamp) return { bg: '#3f1d1d', fg: '#fca5a5', text: 'keine Events' }
    const ageMs = Date.now() - dayjs(status.last_event_timestamp).valueOf()
    if (ageMs > 24 * 3600_000) return { bg: '#3f1d1d', fg: '#fca5a5', text: '>24h alt' }
    if (ageMs > 2 * 3600_000) return { bg: '#3f341d', fg: '#fde68a', text: 'verzögert' }
    return { bg: '#173d2a', fg: '#86efac', text: 'aktuell' }
  }

  return (
    <div>
      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <h2 style={styles.h2}>Dashboard</h2>
          <HelpTip content="Hier waehlst du Quellen und Zeitfenster fuer den aktuellen Analysekontext. Alle Metriken auf dieser Seite reagieren direkt auf diese Auswahl." ariaLabel="Dashboard erklaeren" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
            <TimeRangePicker value={rangeHours} onChange={handleRangeHoursChange} />
            <HelpTip content="Das Zeitfenster steuert, wie weit die Metriken in die Vergangenheit schauen. 'Alle' verwendet den kompletten verfuegbaren Datenbestand." ariaLabel="Zeitfenster erklaeren" />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span style={{ color: '#64748b', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Raster</span>
            <select
              value={chartBucketMode}
              onChange={e => setChartBucketMode(e.target.value)}
              style={styles.bucketSelect}
            >
              {CHART_BUCKETS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
            {chartBucketMode === 'auto' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <span style={{ color: '#64748b', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Auto</span>
                  <div style={styles.autoProfileGroup} role="group" aria-label="Auto-Refresh-Profil">
                    {AUTO_REFRESH_PROFILES.map(profile => {
                      const active = autoRefreshProfile === profile.value
                      return (
                        <button
                          key={profile.value}
                          type="button"
                          onClick={() => setAutoRefreshProfile(profile.value)}
                          style={{
                            ...styles.autoProfileButton,
                            ...(active ? styles.autoProfileButtonActive : {}),
                          }}
                          aria-pressed={active}
                          title={`Auto-Profil: ${profile.label}`}
                        >
                          {profile.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <HelpTip content="Steuert, wie aggressiv Auto aktualisiert: Ruhig spart Last, Normal ist ausgewogen, Schnell zieht neue Peaks frueher nach. Die Einstellung wird lokal im Browser gespeichert." ariaLabel="Auto-Refresh-Schärfe erklaeren" />
              </>
            )}
          </div>
          <div style={styles.ingestRow}>
            <SourcePicker selected={selectedSources} onChange={handleSelectedSourcesChange} onUploadResult={handleUploadResult} customSources={customSources} onRemoveCustom={removeCustomSource} />
            <HelpTip content="Hier waehlst du konfigurierte Quellen, Standard-Logpfade oder hochgeladene Dateien aus. Die Auswahl definiert gleichzeitig den globalen Datenkontext fuer die Metriken." ariaLabel="Quellenauswahl erklaeren" />
            {ingesting && <span style={{ fontSize: '0.82rem', color: '#fbbf24', whiteSpace: 'nowrap' }}>⏳ Analysiere…</span>}
          </div>
        </div>
      </div>

      {ingestError && (
        <div style={{ ...styles.ingestInfo, background: '#450a0a', color: '#f87171' }}>
          {ingestError}
        </div>
      )}

      {uploadResult && (
        <div style={{ ...styles.ingestInfo, background: isUploadError(uploadResult) ? '#450a0a' : '#0f2d1a', color: isUploadError(uploadResult) ? '#f87171' : '#86efac', position: 'relative' }}>
          <button onClick={() => setUploadResult(null)} style={{ position: 'absolute', top: '0.4rem', right: '0.5rem', background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '1rem' }}>✕</button>
          {isUploadError(uploadResult) ? (
            <div>Upload-Fehler: {uploadResult.error}</div>
          ) : (
            <>
              <div style={{ fontWeight: 600, marginBottom: '0.4rem' }}>
                📄 Importiert: {uploadResult.lines_ingested} Zeilen · {uploadResult.events_created} Events
              </div>
              <div style={{ fontSize: '0.82rem', color: '#d1fae5' }}>
                Quelle: {uploadResult.source_name} ({uploadResult.source_id})
              </div>
            </>
          )}
        </div>
      )}

      {selectedSourceIds.length > 0 && (
        <div style={styles.statusWrap}>
          <div style={styles.statusTitle}>Ingest-Status (ausgewählte Quellen)</div>
          {(sourceStatus.isLoading && !sourceStatus.data) ? (
            <div style={{ color: '#64748b', fontSize: '0.83rem' }}>Lade Status…</div>
          ) : (
            <div style={styles.statusGrid}>
              {selectedSources
                .filter(source => source.kind === 'configured')
                .map(source => {
                  const sourceId = source.id.replace('source:', '')
                  const status = sourceStatusById.get(sourceId)
                  const tone = sourceStatusTone(status)
                  return (
                    <div key={source.id} style={styles.statusCard}>
                      <div style={styles.statusName}>{source.label}</div>
                      <div style={{ ...styles.statusBadge, background: tone.bg, color: tone.fg }}>{tone.text}</div>
                      <div style={styles.statusLine}>
                        Letzter Event-Zeitpunkt: {status?.last_event_timestamp ? dayjs(status.last_event_timestamp).format('DD.MM.YYYY HH:mm:ss') : '–'}
                      </div>
                      <div style={styles.statusLine}>
                        Letzte Ingestion: {status?.last_ingested_at ? dayjs(status.last_ingested_at).format('DD.MM.YYYY HH:mm:ss') : '–'}
                      </div>
                    </div>
                  )
                })}
            </div>
          )}
        </div>
      )}

      {selectedSources.length === 0 ? (
        <div style={{ color: '#475569', textAlign: 'center', padding: '3rem 1rem', fontSize: '0.9rem' }}>
          Bitte eine oder mehrere Log-Quellen auswählen, um Metriken anzuzeigen.
        </div>
      ) : (
        <>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>Kennzahlen</span>
            <HelpTip content="Diese Karten verdichten den aktuell ausgewaehlten Datenbestand. Gesamt-Events zeigt die Menge, Fehlerrate den Anteil problematischer Events und Fehler die absolute Fehlerzahl." ariaLabel="Kennzahlen erklaeren" />
          </div>
          <div style={styles.kpiRow}>
            <KpiCard title="Gesamt Events" value={String(totalEvents)} help="Alle Events, die innerhalb des aktiven Zeitfensters und der ausgewaehlten Quellen gefunden wurden." />
            <KpiCard title="Fehlerrate" value={`${errorRate}%`} help="Anteil aller Events, die als error oder kritischer klassifiziert wurden." />
            <KpiCard title="Fehler" value={String(rr?.error_events ?? '–')} help="Absolute Anzahl fehlerhafter Events im aktuellen Kontext. Das ist der direkte Zaehler zur Fehlerrate." />
          </div>

          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>Aufschluesselungen</span>
            <HelpTip content="Diese Bereiche erklaeren, wie sich das Volumen ueber die Zeit verteilt und welche Fehlermeldungen oder Services besonders haeufig auftreten." ariaLabel="Dashboard-Aufschluesselungen erklaeren" />
          </div>
          <div style={styles.grid}>
            <Panel title={`Events / ${chartBucketMode === 'auto' ? `Auto (${chartBucket})` : chartBucket} (${rangeHours === 0 ? 'alle' : TIME_PRESETS.find(p => p.hours === rangeHours)?.label ?? ''})`} help="Die Linie zeigt, wie viele Events pro Zeitintervall eingegangen sind. Hoehere Ausschlaege markieren Lastspitzen oder Stoerungsphasen.">
              {ts.data ? <MiniBar points={ts.data.points} /> : ts.isError ? <PanelError error={ts.error} /> : <Spinner />}
            </Panel>

            <Panel title="Top Fehler-Meldungen" help="Hier siehst du die haeufigsten Fehlermeldungen im aktuellen Datenfenster. Das hilft beim Clustern wiederkehrender Stoerungen.">
              <div style={styles.panelMetaRow}>
                <span style={styles.panelMetaLabel}>Letztes Update:</span>
                <span style={styles.panelMetaValue}>{formatAgeLabel(errs.dataUpdatedAt)}</span>
              </div>
              <div style={{ marginBottom: '0.75rem', display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Severity:</span>
                <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                  {(['debug', 'info', 'warning', 'error', 'critical'] as const).map(sev => {
                    const isSelected = topErrorsSeverities.includes(sev)
                    const severityColors: Record<string, { bg: string; text: string }> = {
                      debug: { bg: '#334155', text: '#94a3b8' },
                      info: { bg: '#0f3460', text: '#06b6d4' },
                      warning: { bg: '#5d2e0f', text: '#fb923c' },
                      error: { bg: '#5e1b1b', text: '#f87171' },
                      critical: { bg: '#7c1225', text: '#fca5a5' },
                    }
                    const colors = severityColors[sev]
                    return (
                      <button
                        key={sev}
                        onClick={() => {
                          const newSevers = isSelected
                            ? topErrorsSeverities.filter(s => s !== sev)
                            : [...topErrorsSeverities, sev]
                          setTopErrorsSeverities(newSevers)
                        }}
                        style={{
                          padding: '0.35rem 0.6rem',
                          fontSize: '0.75rem',
                          fontWeight: 500,
                          borderRadius: '0.3rem',
                          border: `1.5px solid ${isSelected ? colors.text : '#475569'}`,
                          background: isSelected ? colors.bg : '#0f172a',
                          color: isSelected ? colors.text : '#64748b',
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                          textTransform: 'capitalize',
                          whiteSpace: 'nowrap',
                        }}
                        title={`${sev} ${isSelected ? 'ausgewählt' : 'nicht ausgewählt'}`}
                      >
                        {sev}
                      </button>
                    )
                  })}
                </div>
              </div>
              {topErrorsSeverities.length === 0 && (
                <div style={{ color: '#fbbf24', fontSize: '0.8rem', marginBottom: '0.5rem', fontStyle: 'italic' }}>
                  ⚠ Keine Severity ausgewählt – es werden keine Fehler angezeigt.
                </div>
              )}
              {topErrorsSeverities.length === 0 ? (
                <div style={{ color: '#64748b', fontSize: '0.85rem' }}>–</div>
              ) : errs.data ? (
                <ol style={styles.ol}>
                  {errs.data.items.slice(0, 8).map((errorItem: TopErrorItem, i: number) => (
                    <li key={i} style={styles.li}>
                      <span style={styles.count}>{errorItem.count}</span>
                      <span style={styles.msg}>{(errorItem.key ?? errorItem.message ?? '').slice(0, 80)}</span>
                    </li>
                  ))}
                  {!errs.data.items.length && <div style={{ color: '#64748b', fontSize: '0.85rem' }}>Keine Fehler-Events</div>}
                </ol>
              ) : <Spinner />}
            </Panel>

            <Panel title="Top Services" help="Zeigt, welche Services besonders haeufig Events erzeugen. So erkennst du schnell dominante Systeme oder Hotspots.">
              {svcs.data ? (
                <ol style={styles.ol}>
                  {svcs.data.items.slice(0, 8).map((serviceItem: TopServiceItem, i: number) => (
                    <li key={i} style={styles.li}>
                      <span style={styles.count}>{serviceItem.count}</span>
                      <span style={styles.msg}>{serviceItem.service ?? '(unbekannt)'}</span>
                    </li>
                  ))}
                  {!svcs.data.items.length && <div style={{ color: '#64748b', fontSize: '0.85rem' }}>Keine Service-Daten</div>}
                </ol>
              ) : <Spinner />}
            </Panel>
          </div>
        </>
      )}
    </div>
  )
}

function KpiCard({ title, value, help }: { title: string; value: string; help?: string }) {
  return (
    <div style={styles.kpi}>
      <div style={styles.kpiVal}>{value}</div>
      <div style={styles.kpiLabelRow}>
        <div style={styles.kpiLabel}>{title}</div>
        {help && <HelpTip content={help} ariaLabel={`${title} erklaeren`} />}
      </div>
    </div>
  )
}

function Panel({ title, help, children }: { title: string; help?: string; children: React.ReactNode }) {
  return (
    <div style={styles.panel}>
      <div style={styles.panelTitleRow}>
        <h3 style={styles.panelTitle}>{title}</h3>
        {help && <HelpTip content={help} ariaLabel={`${title} erklaeren`} />}
      </div>
      {children}
    </div>
  )
}

function Spinner() {
  return <div style={{ color: '#64748b', padding: '1rem' }}>Lade…</div>
}

function PanelError({ error }: { error: unknown }) {
  return (
    <div style={{ color: '#f87171', padding: '1rem', fontSize: '0.85rem' }}>
      Fehler beim Laden: {getApiErrorMessage(error)}
    </div>
  )
}

function MiniBar({ points }: { points: { ts: string; count: number }[] }) {
  if (!points.length) return <div style={{ color: '#64748b' }}>Keine Daten</div>

  function getChartHeight() {
    if (typeof window === 'undefined') return 200
    const w = window.innerWidth
    if (w < 768) return 140
    if (w < 1200) return 170
    return 200
  }

  function formatCount(v: number) {
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
    return String(v)
  }

  const [chartHeight, setChartHeight] = useState(getChartHeight)
  const [hoverState, setHoverState] = useState<{ index: number; x: number; y: number } | null>(null)

  useEffect(() => {
    function onResize() {
      setChartHeight(getChartHeight())
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const W = 1000
  const H = chartHeight
  const pad = { top: 12, right: 10, bottom: 42, left: 58 }
  const innerW = W - pad.left - pad.right
  const innerH = H - pad.top - pad.bottom

  const max = Math.max(...points.map(p => p.count), 1)

  const x = (i: number) => pad.left + (i / (points.length - 1 || 1)) * innerW
  const y = (v: number) => pad.top + innerH - (v / max) * innerH

  const polyline = points.map((p, i) => `${x(i)},${y(p.count)}`).join(' ')
  const hoveredPoint = hoverState ? points[hoverState.index] : null

  // Y-axis: 0 and max labels
  const yLabels = [
    { val: max, yPos: pad.top },
    { val: Math.round(max / 2), yPos: pad.top + innerH / 2 },
    { val: 0,   yPos: pad.top + innerH },
  ]

  // X-axis: first, 1/3, 2/3, last label (deduplicated for small arrays)
  const xLabelIndices = Array.from(new Set([
    0,
    Math.max(0, Math.floor((points.length - 1) / 3)),
    Math.max(0, Math.floor(((points.length - 1) * 2) / 3)),
    Math.max(0, points.length - 1),
  ]))

  const xLabels = xLabelIndices.map((idx, i) => ({
    key: i,
    label: dayjs(points[idx].ts).format('DD.MM HH:mm'),
    xPos: x(idx),
  }))

  function updateHover(clientX: number, rect: DOMRect) {
    const svgX = ((clientX - rect.left) / rect.width) * W
    const clampedX = Math.max(pad.left, Math.min(svgX, pad.left + innerW))
    const nearestIndex = Math.round(((clampedX - pad.left) / innerW) * (points.length - 1 || 1))
    const safeIndex = Math.max(0, Math.min(points.length - 1, nearestIndex))
    setHoverState({
      index: safeIndex,
      x: x(safeIndex),
      y: Math.max(pad.top, Math.min(y(points[safeIndex].count), pad.top + innerH)),
    })
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: chartHeight }}>
      {hoveredPoint && hoverState && (
        <div
          style={{
            ...styles.chartTooltip,
            left: Math.min(Math.max(12, hoverState.x + 12), W - 186),
            top: Math.max(12, hoverState.y - 44),
          }}
        >
          <div style={styles.chartTooltipTime}>{dayjs(hoveredPoint.ts).format('DD.MM.YYYY HH:mm:ss')}</div>
          <div style={styles.chartTooltipValue}>{formatCount(hoveredPoint.count)} Events</div>
        </div>
      )}

      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height: chartHeight, overflow: 'visible', display: 'block' }}
        aria-label="Zeitreihen-Liniendiagramm"
        onMouseLeave={() => setHoverState(null)}
        onMouseMove={e => updateHover(e.clientX, e.currentTarget.getBoundingClientRect())}
      >
        {/* grid line at max */}
        <line
          x1={pad.left} y1={pad.top}
          x2={pad.left + innerW} y2={pad.top}
          stroke="#334155" strokeDasharray="3 3" strokeWidth={1}
        />
        {/* grid line at 0 / baseline */}
        <line
          x1={pad.left} y1={pad.top + innerH}
          x2={pad.left + innerW} y2={pad.top + innerH}
          stroke="#334155" strokeWidth={1}
        />

        {/* filled area under the line */}
        <polygon
          points={`${x(0)},${pad.top + innerH} ${polyline} ${x(points.length - 1)},${pad.top + innerH}`}
          fill="#3b82f6"
          fillOpacity={0.15}
        />

        {/* hover guide line */}
        {hoveredPoint && hoverState && (
          <line
            x1={hoverState.x}
            y1={pad.top}
            x2={hoverState.x}
            y2={pad.top + innerH}
            stroke="#60a5fa"
            strokeDasharray="4 4"
            strokeWidth={1}
          />
        )}

        {/* the line itself */}
        <polyline
          points={polyline}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={3}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* data-point dots (only when few points) */}
        {points.length <= 30 && points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.count)} r={3} fill="#3b82f6">
            <title>{`${dayjs(p.ts).format('DD.MM HH:mm')}: ${p.count}`}</title>
          </circle>
        ))}

        {/* highlighted hover dot */}
        {hoveredPoint && hoverState && (
          <circle
            cx={hoverState.x}
            cy={hoverState.y}
            r={5}
            fill="#dbeafe"
            stroke="#3b82f6"
            strokeWidth={2}
          />
        )}

        {/* transparent hover capture layer */}
        <rect
          x={pad.left}
          y={pad.top}
          width={innerW}
          height={innerH}
          fill="transparent"
          style={{ cursor: 'crosshair' }}
          onMouseEnter={e => updateHover(e.clientX, e.currentTarget.ownerSVGElement!.getBoundingClientRect())}
          onMouseMove={e => updateHover(e.clientX, e.currentTarget.ownerSVGElement!.getBoundingClientRect())}
          onMouseLeave={() => setHoverState(null)}
        />

        {/* Y-axis labels */}
        {yLabels.map(({ val, yPos }) => (
          <text
            key={yPos}
            x={pad.left - 4}
            y={yPos}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize={12}
            fill="#64748b"
          >
            {formatCount(val)}
          </text>
        ))}

        {/* X-axis labels */}
        {xLabels.map(({ key, label, xPos }, i) => (
          <text
            key={key}
            x={xPos}
            y={H - 6}
            textAnchor={i === 0 ? 'start' : i === xLabels.length - 1 ? 'end' : 'middle'}
            fontSize={13}
            fill="#64748b"
          >
            {label}
          </text>
        ))}
      </svg>
    </div>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', gap: '1rem', flexWrap: 'wrap' },
  h2: { margin: 0, fontSize: '1.5rem' },
  ingestRow: { display: 'flex', gap: '0.5rem', alignItems: 'center' },
  ingestBtn: {
    background: '#3b82f6', color: '#fff', border: 'none',
    borderRadius: 8, padding: '0.55rem 1.1rem', cursor: 'pointer', fontWeight: 600, flexShrink: 0, whiteSpace: 'nowrap',
  },
  ingestInfo: {
    background: '#1e3a5f', borderRadius: 8, padding: '0.75rem 1rem',
    marginBottom: '1.5rem', fontSize: '0.85rem', color: '#93c5fd',
    display: 'flex', flexDirection: 'column', gap: '0.25rem',
  },
  chartTooltip: {
    position: 'absolute',
    zIndex: 20,
    minWidth: 170,
    maxWidth: 220,
    padding: '0.5rem 0.65rem',
    borderRadius: 10,
    border: '1px solid rgba(59, 130, 246, 0.35)',
    background: 'rgba(15, 23, 42, 0.98)',
    boxShadow: '0 14px 30px rgba(2, 6, 23, 0.42)',
    pointerEvents: 'none',
  },
  chartTooltipTime: {
    color: '#cbd5e1',
    fontSize: '0.72rem',
    marginBottom: '0.2rem',
  },
  chartTooltipValue: {
    color: '#93c5fd',
    fontSize: '0.92rem',
    fontWeight: 700,
  },
  statusWrap: {
    background: '#1e293b', borderRadius: 10, padding: '0.8rem 1rem', border: '1px solid #334155', marginBottom: '1rem',
  },
  statusTitle: { color: '#94a3b8', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.6rem' },
  statusGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.6rem' },
  statusCard: { background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: '0.65rem 0.75rem' },
  statusName: { color: '#e2e8f0', fontSize: '0.86rem', fontWeight: 600, marginBottom: '0.35rem' },
  statusBadge: { display: 'inline-block', borderRadius: 999, padding: '0.12rem 0.5rem', fontSize: '0.72rem', fontWeight: 700, marginBottom: '0.35rem' },
  statusLine: { color: '#94a3b8', fontSize: '0.78rem', lineHeight: 1.45 },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.45rem',
    marginBottom: '0.65rem',
  },
  sectionTitle: {
    color: '#94a3b8',
    fontSize: '0.78rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  kpiRow: { display: 'flex', gap: '1rem', marginBottom: '1.5rem' },
  kpi: { flex: 1, background: '#1e293b', borderRadius: 10, padding: '1.25rem 1.5rem', border: '1px solid #334155' },
  kpiVal: { fontSize: '2rem', fontWeight: 700, color: '#93c5fd' },
  kpiLabel: { color: '#64748b', fontSize: '0.85rem', marginTop: '0.25rem' },
  kpiLabelRow: { display: 'flex', alignItems: 'center', gap: '0.35rem', marginTop: '0.25rem' },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' },
  panel: { background: '#1e293b', borderRadius: 10, padding: '1.25rem', border: '1px solid #334155' },
  panelTitle: { margin: '0 0 1rem 0', fontSize: '0.95rem', color: '#94a3b8' },
  panelTitleRow: { display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '1rem' },
  panelMetaRow: { display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.65rem' },
  panelMetaLabel: { color: '#64748b', fontSize: '0.76rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' },
  panelMetaValue: { color: '#cbd5e1', fontSize: '0.8rem' },
  ol: { margin: 0, padding: '0 0 0 1.2rem' },
  li: { display: 'flex', gap: '0.75rem', marginBottom: '0.4rem', fontSize: '0.82rem', color: '#f1f5f9' },
  count: { background: '#1e3a5f', color: '#93c5fd', borderRadius: 4, padding: '0 0.4rem', flexShrink: 0 },
  msg: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  bucketSelect: {
    background: '#0f172a',
    color: '#e2e8f0',
    border: '1px solid #334155',
    borderRadius: 6,
    padding: '0.35rem 0.55rem',
    fontSize: '0.82rem',
  },
  autoProfileGroup: {
    display: 'inline-flex',
    border: '1px solid #334155',
    borderRadius: 8,
    overflow: 'hidden',
    background: '#0f172a',
  },
  autoProfileButton: {
    background: 'transparent',
    color: '#94a3b8',
    border: 'none',
    borderRight: '1px solid #334155',
    padding: '0.32rem 0.55rem',
    fontSize: '0.76rem',
    fontWeight: 700,
    cursor: 'pointer',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  autoProfileButtonActive: {
    background: '#1d4ed8',
    color: '#fff',
  },
}
