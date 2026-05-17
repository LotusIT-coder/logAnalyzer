import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  getEvents,
  getErrorRate,
  getEventVolumeCheck,
  getIncidents,
  getMitreCoverage,
  getSocAnalystStatus,
  getSourceIngestionStatus,
  getServerTime,
  getTimeseries,
  getTopErrors,
  getTopServices,
  runIngestion,
  setSocAnalystStatus,
  type EventResponse,
  type IncidentResponse,
  type MetricsFilter,
  type SourceIngestionStatus,
  type TimeRange,
  type TimeseriesResponse,
  type TopErrorItem,
  type TopServiceItem,
} from '../lib/requests'
import { useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import { getApiErrorMessage } from '../lib/errors'
import HelpTip from '../components/HelpTip'
import { FormattedMessage } from '../components/FormattedMessage'
import { SourcePicker, type UploadResultState, isUploadError } from '../components/SourcePicker'
import { TimeRangePicker, TIME_PRESETS } from '../components/TimeRangePicker'
import { type SourceOption } from '../ctx/SourceFilterContext.shared'
import { useSourceFilter } from '../ctx/useSourceFilter'
import { useI18n } from '../ctx/I18nContext'

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
const RANGE_CONFIRMATION_THRESHOLD = 5_000_000

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

// Periodisches Tick-Intervall (in ms), das den globalen refreshTick im Dashboard
// hochzaehlt. Steuert, wie oft activeTimeRange (to=now) neu berechnet wird und
// damit die queryKeys von rate/ts/errs/svcs wechseln -> Live-Refetch.
function resolveBaseTickMs(profile: AutoRefreshProfile): number {
  switch (profile) {
    case 'aggressive':
      return 3_000
    case 'conservative':
      return 30_000
    default:
      return 10_000
  }
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

function buildTimeRange(rangeHours: number, serverTimeOffset: number = 0): TimeRange | undefined {
  if (rangeHours === 0) return undefined
  // Use server-synchronized time to fix time-skew bugs
  const now = new Date(Date.now() + serverTimeOffset)
  return {
    from: new Date(now.getTime() - rangeHours * 3600_000).toISOString(),
    to: now.toISOString(),
  }
}

function toDateTimeLocalInput(iso?: string) {
  if (!iso) return ''
  const parsed = dayjs(iso)
  return parsed.isValid() ? parsed.format('YYYY-MM-DDTHH:mm') : ''
}

function toIsoFromDateTimeLocal(value: string) {
  if (!value) return undefined
  const parsed = dayjs(value)
  return parsed.isValid() ? parsed.toISOString() : undefined
}

function formatMetaValue(value: unknown) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function getEventObservedAt(event: EventResponse) {
  return event.created_at ?? event.timestamp
}

interface TopErrorDetailTarget {
  query: string
  label: string
  count: number
  // If set, the detail modal filters by service= instead of q=.
  service?: string
  titleOverride?: string
  subtitlePrefix?: string
}

interface MitreTechniqueDetailTarget {
  techniqueId: string
  tactic?: string | null
  ruleCount: number
  incidentCount: number
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { t } = useI18n()
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
  const [socToggleBusy, setSocToggleBusy] = useState(false)
  const [socToggleError, setSocToggleError] = useState<string | null>(null)
  const [manualRefreshing, setManualRefreshing] = useState(false)
  const [uploadResult, setUploadResult] = useState<UploadResultState | null>(null)
  const [topErrorsSeverities, setTopErrorsSeverities] = useState<string[]>(['error', 'critical'])
  const [topErrorDetail, setTopErrorDetail] = useState<TopErrorDetailTarget | null>(null)
  const [mitreDetail, setMitreDetail] = useState<MitreTechniqueDetailTarget | null>(null)
  const [serverTimeOffset, setServerTimeOffset] = useState<number>(0)
  const [rangeCheckBusy, setRangeCheckBusy] = useState(false)
  // Live-Tick: zwingt activeTimeRange.to auf 'jetzt' und triggert via queryKey
  // Refetches in allen relevanten Dashboard-Queries.
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    const tickMs = resolveBaseTickMs(autoRefreshProfile)
    const id = window.setInterval(() => setRefreshTick(v => v + 1), tickMs)
    return () => window.clearInterval(id)
  }, [autoRefreshProfile])

  // Synchronize client time with server time to fix time-skew bugs
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
        setServerTimeOffset(0)
      }
    }
    void syncServerTime()
  }, [])

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
      void refetchAll()
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

  async function handleRangeHoursChange(nextRangeHours: number) {
    if (nextRangeHours === rangeHours) return

    const nextSelectedSourceIds = selectedSources
      .filter(source => source.kind === 'configured')
      .map(source => source.id.replace('source:', ''))
    const nextSelectedSourcePaths = selectedSources
      .filter(source => source.kind === 'preset' || source.kind === 'custom')
      .map(source => source.path)

    const nextMetricsFilter: MetricsFilter | undefined = selectedSources.length > 0
      ? { sourceIds: nextSelectedSourceIds, sourcePaths: nextSelectedSourcePaths }
      : undefined

    setRangeCheckBusy(true)
    try {
      const volume = await getEventVolumeCheck(
        buildTimeRange(nextRangeHours, serverTimeOffset),
        nextMetricsFilter,
        RANGE_CONFIRMATION_THRESHOLD,
      )
      if (volume.requires_confirmation) {
        const checkedEvents = volume.checked_events.toLocaleString('de-DE')
        const thresholdLabel = volume.threshold.toLocaleString('de-DE')
        const rangeLabel = TIME_PRESETS.find(p => p.hours === nextRangeHours)?.label ?? `${nextRangeHours} h`
        const confirmed = window.confirm(
          `Die Auswahl ${rangeLabel} umfasst mindestens ${checkedEvents} Eintraege und liegt damit ueber der Grenze von ${thresholdLabel}.\n\nTrotzdem laden?`,
        )
        if (!confirmed) return
      }
    } catch (error) {
      console.warn('Volume check failed, continuing without confirmation guard:', error)
    } finally {
      setRangeCheckBusy(false)
    }

    if (nextRangeHours === 0) {
      const typedConfirmation = window.prompt('Sicherheitsabfrage: Tippe ALLE, um den kompletten Datenbestand zu laden.')
      if (typedConfirmation !== 'ALLE') return
    }

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
  const activeTimeRange = useMemo(
    () => buildTimeRange(rangeHours, serverTimeOffset),
    // refreshTick ist Absicht: zwingt eine neue 'to=now'-Berechnung bei jedem Tick,
    // damit die queryKeys der nachgelagerten Queries wechseln und Live-Refetches
    // mit aktuellem Zeitfenster ausgeloest werden.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rangeHours, refreshTick, serverTimeOffset],
  )

  const sourceKey = `${selectedSourceIds.join('|')}::${selectedSourcePaths.join('|')}`

  const chartBucket = chartBucketMode === 'auto' ? resolveChartBucket(rangeHours) : chartBucketMode

  const rate = useQuery({
    queryKey: ['error-rate', rangeHours, sourceKey],
    queryFn: () => getErrorRate(buildTimeRange(rangeHours, serverTimeOffset), metricsFilter),
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
      const timeRange = buildTimeRange(rangeHours, serverTimeOffset)
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
    queryKey: ['top-errors', rangeHours, sourceKey, topErrorsSeverities.join(','), activeTimeRange?.to ?? ''],
    queryFn: () => getTopErrors(activeTimeRange, metricsFilter),
    enabled: selectedSources.length > 0 && topErrorsSeverities.length > 0,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    refetchInterval: drilldownRefreshMs,
    refetchIntervalInBackground: true,
  })
  const svcs = useQuery({
    queryKey: ['top-services', rangeHours, sourceKey, activeTimeRange?.to ?? ''],
    queryFn: () => getTopServices(activeTimeRange, metricsFilter),
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
    staleTime: 5_000,
    placeholderData: keepPreviousData,
    refetchInterval: resolveBaseTickMs(autoRefreshProfile),
    refetchIntervalInBackground: true,
  })

  const socAnalyst = useQuery({
    queryKey: ['soc-analyst-status'],
    queryFn: getSocAnalystStatus,
    staleTime: 5_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
  })

  async function refetchAll() {
    setManualRefreshing(true)
    try {
      await Promise.allSettled([
        ts.refetch(),
        errs.refetch(),
        svcs.refetch(),
        rate.refetch(),
        sourceStatus.refetch(),
        mitreCoverage.refetch(),
        socAnalyst.refetch(),
      ])
    } finally {
      setManualRefreshing(false)
    }
  }

  const mitreCoverage = useQuery({
    queryKey: ['mitre-coverage'],
    queryFn: getMitreCoverage,
    enabled: selectedSources.length > 0,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    refetchInterval: drilldownRefreshMs,
    refetchIntervalInBackground: true,
  })

  async function toggleSocAnalystMonitoring() {
    const currentlyEnabled = !!socAnalyst.data?.enabled
    setSocToggleBusy(true)
    setSocToggleError(null)

    const payload = {
      enabled: !currentlyEnabled,
      sourceIds: selectedSourceIds,
      sourcePaths: selectedSourcePaths,
    }

    try {
      await setSocAnalystStatus(payload)
      await socAnalyst.refetch()
    } catch (error: unknown) {
      // Some setups briefly return 502 via proxy even though backend is reachable.
      const statusCode = (error as { response?: { status?: number } })?.response?.status
      if (statusCode === 502) {
        try {
          await new Promise(resolve => window.setTimeout(resolve, 450))
          await setSocAnalystStatus(payload)
          await socAnalyst.refetch()
          setSocToggleBusy(false)
          return
        } catch {
          // Fall through to unified error handling below.
        }
      }
      setSocToggleError(getApiErrorMessage(error, 'KI-Ueberwachung konnte nicht aktualisiert werden.'))
    } finally {
      setSocToggleBusy(false)
    }
  }

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

  const isAnyQueryLoading = ts.isLoading || errs.isLoading || svcs.isLoading || rate.isLoading || sourceStatus.isLoading || mitreCoverage.isLoading || socAnalyst.isLoading

  void clockTick

  function sourceStatusTone(status?: SourceIngestionStatus) {
    const freshestSeenAt = status?.last_event_created_at ?? status?.last_event_timestamp
    if (!freshestSeenAt) return { bg: 'color-mix(in srgb, var(--danger-fg) 16%, var(--surface))', fg: 'var(--danger-fg)', text: 'keine Events' }
    const ageMs = Date.now() - dayjs(freshestSeenAt).valueOf()
    if (ageMs > 24 * 3600_000) return { bg: 'color-mix(in srgb, var(--danger-fg) 16%, var(--surface))', fg: 'var(--danger-fg)', text: '>24h alt' }
    if (ageMs > 2 * 3600_000) return { bg: 'color-mix(in srgb, var(--warning-fg) 16%, var(--surface))', fg: 'var(--warning-fg)', text: 'verzögert' }
    return { bg: 'color-mix(in srgb, var(--success-fg) 16%, var(--surface))', fg: 'var(--success-fg)', text: 'aktuell' }
  }

  return (
    <div>
      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <h2 style={styles.h2}>Dashboard</h2>
          <HelpTip content="Hier waehlst du Quellen und Zeitfenster fuer den aktuellen Analysekontext. Alle Metriken auf dieser Seite reagieren direkt auf diese Auswahl." ariaLabel="Dashboard erklaeren" />
        </div>
        <button onClick={() => void refetchAll()} disabled={isAnyQueryLoading || manualRefreshing} style={styles.refBtn}>
          {(isAnyQueryLoading || manualRefreshing) ? 'Aktualisiere...' : 'Aktualisieren'}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
            <TimeRangePicker value={rangeHours} onChange={handleRangeHoursChange} disabled={rangeCheckBusy} />
            {/* Loading text for volume check removed: check is now always fast */}
            <HelpTip content="Das Zeitfenster steuert, wie weit die Metriken in die Vergangenheit schauen. 'Alle' verwendet den kompletten verfuegbaren Datenbestand." ariaLabel="Zeitfenster erklaeren" />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span style={{ color: 'var(--muted-fg)', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Raster</span>
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
                  <span style={{ color: 'var(--muted-fg)', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Auto</span>
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
          <div style={styles.socToggleWrap}>
            <span style={{ color: 'var(--muted-fg)', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              KI-Ueberwachung
            </span>
            <span
              style={{
                ...styles.socStatusPill,
                background: socAnalyst.data?.running
                  ? 'color-mix(in srgb, var(--success-fg) 18%, var(--surface))'
                  : 'color-mix(in srgb, var(--danger-fg) 16%, var(--surface))',
                color: socAnalyst.data?.running ? 'var(--success-fg)' : 'var(--danger-fg)',
              }}
              title={socAnalyst.data?.enabled
                ? (socAnalyst.data?.source_ids?.length
                  ? `Aktiv fuer ${socAnalyst.data.source_ids.length} Quelle(n)`
                  : 'Aktiv fuer alle verfuegbaren Logs')
                : 'Deaktiviert'}
            >
              {socAnalyst.isLoading
                ? 'Status: lade...'
                : socAnalyst.data?.running
                  ? 'Status: aktiv'
                  : socAnalyst.data?.enabled
                    ? 'Status: startet'
                    : 'Status: inaktiv'}
            </span>
            <button
              type="button"
              onClick={toggleSocAnalystMonitoring}
              disabled={socToggleBusy || socAnalyst.isLoading}
              style={socAnalyst.data?.enabled ? styles.socDisableBtn : styles.socEnableBtn}
              title={socAnalyst.data?.enabled
                ? 'KI-Ueberwachung deaktivieren'
                : 'KI-Ueberwachung fuer die aktuelle Quellenauswahl aktivieren'}
            >
              {socToggleBusy
                ? 'Aktualisiere...'
                : socAnalyst.data?.enabled
                  ? 'Deaktivieren'
                  : 'Aktivieren'}
            </button>
            <HelpTip content="Schaltet die permanente SOC-KI-Ueberwachung ein oder aus. Beim Aktivieren wird die aktuelle Quellenauswahl als Filter gespeichert und bleibt auch nach Neustarts aktiv." ariaLabel="KI-Ueberwachung erklaeren" />
          </div>
          <div style={styles.ingestRow}>
            <SourcePicker selected={selectedSources} onChange={handleSelectedSourcesChange} onUploadResult={handleUploadResult} customSources={customSources} onRemoveCustom={removeCustomSource} />
            <HelpTip content="Hier waehlst du konfigurierte Quellen, Standard-Logpfade oder hochgeladene Dateien aus. Die Auswahl definiert gleichzeitig den globalen Datenkontext fuer die Metriken." ariaLabel="Quellenauswahl erklaeren" />
            {ingesting && <span style={{ fontSize: '0.82rem', color: 'var(--warning-fg)', whiteSpace: 'nowrap' }}>⏳ Analysiere…</span>}
          </div>
        </div>
      </div>

      {socToggleError && (
        <div style={{ ...styles.ingestInfo, background: 'color-mix(in srgb, var(--danger-fg) 16%, var(--surface))', color: 'var(--danger-fg)' }}>
          {socToggleError}
        </div>
      )}

      {ingestError && (
        <div style={{ ...styles.ingestInfo, background: 'color-mix(in srgb, var(--danger-fg) 16%, var(--surface))', color: 'var(--danger-fg)' }}>
          {ingestError}
        </div>
      )}

      {uploadResult && (
        <div style={{ ...styles.ingestInfo, background: isUploadError(uploadResult) ? 'color-mix(in srgb, var(--danger-fg) 16%, var(--surface))' : 'color-mix(in srgb, var(--success-fg) 16%, var(--surface))', color: isUploadError(uploadResult) ? 'var(--danger-fg)' : 'var(--success-fg)', position: 'relative' }}>
          <button onClick={() => setUploadResult(null)} style={{ position: 'absolute', top: '0.4rem', right: '0.5rem', background: 'none', border: 'none', color: 'var(--muted-fg)', cursor: 'pointer', fontSize: '1rem' }}>✕</button>
          {isUploadError(uploadResult) ? (
            <div>{t('dashboard.uploadError', { message: uploadResult.error })}</div>
          ) : (
            <>
              <div style={{ fontWeight: 600, marginBottom: '0.4rem' }}>
                📄 {t('dashboard.imported', { lines: uploadResult.lines_ingested, events: uploadResult.events_created })}
              </div>
              <div style={{ fontSize: '0.82rem', color: 'var(--fg)' }}>
                {t('dashboard.source')}: {uploadResult.source_name} ({uploadResult.source_id})
              </div>
            </>
          )}
        </div>
      )}

      {selectedSourceIds.length > 0 && (
        <div style={styles.statusWrap}>
          <div style={styles.statusTitle}>{t('dashboard.ingestStatus')}</div>
          {(sourceStatus.isLoading && !sourceStatus.data) ? (
            <div style={{ color: 'var(--muted-fg)', fontSize: '0.83rem' }}>{t('dashboard.loadingStatus')}</div>
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
                        {t('dashboard.lastIngestEvent')}: {status?.last_event_created_at ? dayjs(status.last_event_created_at).format('DD.MM.YYYY HH:mm:ss') : '–'}
                      </div>
                      <div style={styles.statusLine}>
                        {t('dashboard.lastLogTime')}: {status?.last_event_timestamp ? dayjs(status.last_event_timestamp).format('DD.MM.YYYY HH:mm:ss') : '–'}
                      </div>
                      <div style={styles.statusLine}>
                        {t('dashboard.lastIngestion')}: {status?.last_ingested_at ? dayjs(status.last_ingested_at).format('DD.MM.YYYY HH:mm:ss') : '–'}
                      </div>
                    </div>
                  )
                })}
            </div>
          )}
        </div>
      )}

      {selectedSources.length === 0 ? (
        <div style={{ color: 'var(--muted-fg)', textAlign: 'center', padding: '3rem 1rem', fontSize: '0.9rem' }}>
          {t('dashboard.selectSources')}
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
                <span style={{ fontSize: '0.75rem', color: 'var(--muted-fg)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Severity:</span>
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
                          border: `1.5px solid ${isSelected ? colors.text : 'var(--border)'}`,
                          background: isSelected ? colors.bg : 'var(--surface)',
                          color: isSelected ? colors.text : 'var(--muted-fg)',
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
                <div style={{ color: 'var(--warning-fg)', fontSize: '0.8rem', marginBottom: '0.5rem', fontStyle: 'italic' }}>
                  ⚠ Keine Severity ausgewählt – es werden keine Fehler angezeigt.
                </div>
              )}
              {topErrorsSeverities.length === 0 ? (
                <div style={{ color: 'var(--muted-fg)', fontSize: '0.85rem' }}>–</div>
              ) : errs.data ? (
                <ol style={styles.ol}>
                  {errs.data.items.slice(0, 8).map((errorItem: TopErrorItem, i: number) => (
                    <li key={i} style={styles.li}>
                      <button
                        type="button"
                        style={styles.topEntryButton}
                        onClick={() => {
                          const fullText = (errorItem.key ?? errorItem.message ?? '').trim()
                          if (!fullText) return
                          setTopErrorDetail({
                            query: fullText,
                            label: fullText.slice(0, 120),
                            count: errorItem.count,
                          })
                        }}
                        title="Details zu diesem Fehlertyp öffnen"
                      >
                        <span style={styles.count}>{errorItem.count}</span>
                        <span style={styles.msg}>{(errorItem.key ?? errorItem.message ?? '').slice(0, 80)}</span>
                      </button>
                    </li>
                  ))}
                  {!errs.data.items.length && <div style={{ color: 'var(--muted-fg)', fontSize: '0.85rem' }}>Keine Fehler-Events</div>}
                </ol>
              ) : <Spinner />}
            </Panel>

            <Panel title="Top Services" help="Zeigt, welche Services besonders haeufig Events erzeugen. So erkennst du schnell dominante Systeme oder Hotspots.">
              {svcs.data ? (
                <ol style={styles.ol}>
                  {svcs.data.items.slice(0, 8).map((serviceItem: TopServiceItem, i: number) => {
                    const serviceName = serviceItem.service ?? ''
                    const label = serviceName || '(unbekannt)'
                    return (
                      <li key={i} style={styles.li}>
                        <button
                          type="button"
                          style={styles.topEntryButton}
                          onClick={() => {
                            if (!serviceName) return
                            setTopErrorDetail({
                              query: '',
                              service: serviceName,
                              label,
                              count: serviceItem.count,
                              titleOverride: 'Details: Top Service',
                              subtitlePrefix: 'Service',
                            })
                          }}
                          disabled={!serviceName}
                          title={serviceName ? 'Events dieses Services anzeigen' : 'Kein Service-Name verfügbar'}
                        >
                          <span style={styles.count}>{serviceItem.count}</span>
                          <span style={styles.msg}>{label}</span>
                        </button>
                      </li>
                    )
                  })}
                  {!svcs.data.items.length && <div style={{ color: 'var(--muted-fg)', fontSize: '0.85rem' }}>Keine Service-Daten</div>}
                </ol>
              ) : <Spinner />}
            </Panel>

            <Panel title="MITRE Coverage" help="Zeigt, welche MITRE-Techniken aktuell durch Regeln und Incidents abgedeckt sind.">
              {mitreCoverage.data ? (
                <>
                  <div style={styles.panelMetaRow}>
                    <span style={styles.panelMetaLabel}>Mapped Rules:</span>
                    <span style={styles.panelMetaValue}>{mitreCoverage.data.mapped_rules}</span>
                  </div>
                  <div style={styles.panelMetaRow}>
                    <span style={styles.panelMetaLabel}>Mapped Incidents:</span>
                    <span style={styles.panelMetaValue}>{mitreCoverage.data.mapped_incidents}</span>
                  </div>
                  <ol style={styles.ol}>
                    {mitreCoverage.data.items.slice(0, 8).map(item => (
                      <li key={item.technique_id} style={styles.li}>
                        <button
                          type="button"
                          style={styles.topEntryButton}
                          onClick={() => setMitreDetail({
                            techniqueId: item.technique_id,
                            tactic: item.tactic,
                            ruleCount: item.rule_count,
                            incidentCount: item.incident_count,
                          })}
                          title="Incidents zu dieser MITRE-Technik anzeigen"
                        >
                          <span style={styles.count}>{item.incident_count}</span>
                          <span style={styles.msg}>
                            {item.technique_id}
                            {item.tactic ? ` (${item.tactic})` : ''}
                            {` · rules ${item.rule_count}`}
                          </span>
                        </button>
                      </li>
                    ))}
                    {!mitreCoverage.data.items.length && (
                      <div style={{ color: 'var(--muted-fg)', fontSize: '0.85rem' }}>Keine MITRE-Mappings</div>
                    )}
                  </ol>
                </>
              ) : mitreCoverage.isError ? (
                <PanelError error={mitreCoverage.error} />
              ) : (
                <Spinner />
              )}
            </Panel>
          </div>
        </>
      )}

      {topErrorDetail && (
        <TopErrorDetailModal
          target={topErrorDetail}
          sourceIds={selectedSourceIds}
          sourcePaths={selectedSourcePaths}
          initialFrom={activeTimeRange?.from}
          initialTo={activeTimeRange?.to}
          onClose={() => setTopErrorDetail(null)}
        />
      )}
      {mitreDetail && (
        <MitreTechniqueDetailModal
          target={mitreDetail}
          sourceIds={selectedSourceIds}
          sourcePaths={selectedSourcePaths}
          onClose={() => setMitreDetail(null)}
        />
      )}
    </div>
  )
}

function TopErrorDetailModal({
  target,
  sourceIds,
  sourcePaths,
  initialFrom,
  initialTo,
  onClose,
}: {
  target: TopErrorDetailTarget
  sourceIds: string[]
  sourcePaths: string[]
  initialFrom?: string
  initialTo?: string
  onClose: () => void
}) {
  const { t } = useI18n()
  const [fromInput, setFromInput] = useState(() => toDateTimeLocalInput(initialFrom))
  const [toInput, setToInput] = useState(() => toDateTimeLocalInput(initialTo))
  const [appliedFromInput, setAppliedFromInput] = useState(() => toDateTimeLocalInput(initialFrom))
  const [appliedToInput, setAppliedToInput] = useState(() => toDateTimeLocalInput(initialTo))
  const [localSearch, setLocalSearch] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Reset Filter / Auswahl nur, wenn das Modal-Target wechselt (anderer Service /
    // andere Top-Fehlermeldung). NICHT auf Aenderungen von initialFrom/initialTo
    // reagieren - die werden vom Dashboard-Auto-Refresh staendig neu berechnet
    // und wuerden sonst das aufgeklappte Detail-Panel im Sekundentakt zuklappen.
    const nextFrom = toDateTimeLocalInput(initialFrom)
    const nextTo = toDateTimeLocalInput(initialTo)
    setFromInput(nextFrom)
    setToInput(nextTo)
    setAppliedFromInput(nextFrom)
    setAppliedToInput(nextTo)
    setLocalSearch('')
    setExpanded({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.query, target.service])

  const fromIso = toIsoFromDateTimeLocal(appliedFromInput)
  const toIso = toIsoFromDateTimeLocal(appliedToInput)

  const {
    data,
    isLoading,
    isError,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetching,
  } = useInfiniteQuery({
    queryKey: ['top-error-detail', target.query, target.service ?? '', sourceIds.join('|'), sourcePaths.join('|'), fromIso, toIso],
    queryFn: ({ pageParam }: { pageParam?: string }) => getEvents({
      limit: 100,
      cursor: pageParam,
      ...(target.service ? { service: target.service } : { q: target.query }),
      ...(fromIso ? { from: fromIso } : {}),
      ...(toIso ? { to: toIso } : {}),
      ...(sourceIds.length ? { source_ids: sourceIds.join(',') } : {}),
      ...(sourcePaths.length ? { source_paths: sourcePaths.join(',') } : {}),
    }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    staleTime: 20_000,
  })

  const allEvents = data?.pages.flatMap(page => page.items) ?? []
  const normalizedLocalSearch = localSearch.trim().toLowerCase()
  const filteredEvents = normalizedLocalSearch
    ? allEvents.filter(event => {
      const searchable = [
        event.message,
        event.id,
        event.source_id,
        event.severity,
        event.host,
        event.service,
        event.timestamp,
      ]
      for (const chunk of searchable) {
        if (String(chunk ?? '').toLowerCase().includes(normalizedLocalSearch)) return true
      }
      return false
    })
    : allEvents

  useEffect(() => {
    const container = listRef.current
    if (!container || !hasNextPage || isFetchingNextPage) return

    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container
      if (scrollTop + clientHeight >= scrollHeight * 0.8) {
        fetchNextPage()
      }
    }

    container.addEventListener('scroll', onScroll)
    return () => container.removeEventListener('scroll', onScroll)
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  function applyDateFilter() {
    setAppliedFromInput(fromInput)
    setAppliedToInput(toInput)
  }

  function resetDateFilter() {
    setFromInput('')
    setToInput('')
    setAppliedFromInput('')
    setAppliedToInput('')
  }

  function toggleExpand(eventId: string) {
    setExpanded(prev => ({ ...prev, [eventId]: !prev[eventId] }))
  }

  return (
    <div style={styles.detailModalOverlay} onClick={onClose}>
      <div style={styles.detailModalBox} onClick={e => e.stopPropagation()}>
        <div style={styles.detailModalHeader}>
          <div style={{ minWidth: 0 }}>
            <div style={styles.detailModalTitle}>{target.titleOverride ?? t('dashboard.detail.titleTopError')}</div>
            <div style={styles.detailModalSubtitle} title={target.service ?? target.query}>
              {(target.subtitlePrefix ?? t('dashboard.detail.type'))}: {target.label}
            </div>
          </div>
          <button type="button" onClick={onClose} style={styles.detailModalCloseBtn}>x {t('dashboard.detail.close')}</button>
        </div>

        <div style={styles.detailModalFilterRow}>
          <span style={styles.detailFilterLabel}>{t('dashboard.detail.from')}</span>
          <input
            type="datetime-local"
            value={fromInput}
            onChange={e => setFromInput(e.target.value)}
            style={styles.detailFilterInput}
          />
          <span style={styles.detailFilterLabel}>{t('dashboard.detail.to')}</span>
          <input
            type="datetime-local"
            value={toInput}
            onChange={e => setToInput(e.target.value)}
            style={styles.detailFilterInput}
          />
          <button type="button" onClick={applyDateFilter} style={styles.detailFilterBtn}>{t('dashboard.detail.searchRange')}</button>
          <button type="button" onClick={resetDateFilter} style={styles.detailResetBtn}>{t('dashboard.detail.reset')}</button>
          <input
            type="text"
            value={localSearch}
            onChange={e => setLocalSearch(e.target.value)}
            placeholder={t('dashboard.detail.searchLoaded')}
            style={{ ...styles.detailFilterInput, minWidth: 240 }}
          />
          {localSearch && (
            <button type="button" onClick={() => setLocalSearch('')} style={styles.detailResetBtn}>{t('dashboard.detail.clearSearch')}</button>
          )}
          <span style={styles.detailMetaText}>
            {t('dashboard.detail.entries', { filtered: filteredEvents.length, total: allEvents.length })}{hasNextPage ? ` ${t('dashboard.detail.moreAvailable')}` : ''}
          </span>
        </div>

        <div ref={listRef} style={styles.detailEventList}>
          {isLoading ? (
            <div style={{ color: 'var(--muted-fg)', padding: '1.25rem' }}>{t('dashboard.detail.loadingEntries')}</div>
          ) : isError ? (
            <div style={{ color: 'var(--danger-fg)', padding: '1.25rem' }}>
              {t('dashboard.detail.loadError', { message: getApiErrorMessage(error) })}
            </div>
          ) : (
            <>
              {filteredEvents.map((event: EventResponse) => {
                const metadata = Object.entries(event).filter(([key]) => key !== 'message')
                const isOpen = !!expanded[event.id]
                return (
                  <div key={event.id} style={styles.detailEventCard}>
                    <button
                      type="button"
                      style={styles.detailEventHeader}
                      onClick={() => toggleExpand(event.id)}
                      title={t('dashboard.detail.toggleMetadata')}
                    >
                      <span style={styles.detailEventTs}>{dayjs(getEventObservedAt(event)).format('DD.MM.YYYY HH:mm:ss')}</span>
                      <span style={{ ...styles.detailEventSeverity, background: (event.severity === 'critical' ? '#ef4444' : event.severity === 'error' ? '#f97316' : event.severity === 'warning' ? '#eab308' : event.severity === 'info' ? '#22c55e' : '#6366f1') }}>
                        {event.severity}
                      </span>
                      <span style={styles.detailEventSource}>{event.source_id ?? '-'}</span>
                      <span style={styles.detailEventHost}>{event.host ?? '-'}</span>
                      <span style={styles.detailEventService}>{event.service ?? '-'}</span>
                    </button>

                    <div style={{ padding: '0.6rem 0.75rem 0.8rem 0.75rem' }}>
                      <FormattedMessage message={event.message} />
                    </div>

                    {isOpen && (
                      <div style={styles.detailMetadataWrap}>
                        {metadata.map(([key, value]) => (
                          <div key={`${event.id}-${key}`} style={styles.detailMetadataRow}>
                            <span style={styles.detailMetadataKey}>{key}</span>
                            <span style={styles.detailMetadataVal}>{formatMetaValue(value)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
              {!filteredEvents.length && (
                <div style={{ color: 'var(--muted-fg)', padding: '1.25rem' }}>
                  {allEvents.length > 0 ? t('dashboard.detail.noLocalHits') : t('dashboard.detail.noEntries')}
                </div>
              )}
              {isFetchingNextPage && (
                <div style={{ color: 'var(--muted-fg)', padding: '0.75rem 1.25rem' }}>{t('dashboard.detail.loadingMore')}</div>
              )}
              {!isFetchingNextPage && isFetching && (
                <div style={{ color: 'var(--muted-fg)', padding: '0.75rem 1.25rem' }}>{t('dashboard.detail.refreshing')}</div>
              )}
              {!hasNextPage && filteredEvents.length > 0 && (
                <div style={{ color: 'var(--muted-fg)', padding: '0.75rem 1.25rem' }}>{t('dashboard.detail.endOfList')}</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function MitreTechniqueDetailModal({
  target,
  sourceIds,
  sourcePaths,
  onClose,
}: {
  target: MitreTechniqueDetailTarget
  sourceIds: string[]
  sourcePaths: string[]
  onClose: () => void
}) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['mitre-technique-detail', sourceIds.join('|'), sourcePaths.join('|')],
    queryFn: () => getIncidents({
      ...(sourceIds.length ? { source_ids: sourceIds.join(',') } : {}),
      ...(sourcePaths.length ? { source_paths: sourcePaths.join(',') } : {}),
    }),
    staleTime: 20_000,
  })

  const matchingIncidents = (data?.items ?? []).filter((incident: IncidentResponse) =>
    Array.isArray(incident.mitre_techniques) && incident.mitre_techniques.includes(target.techniqueId),
  )

  return (
    <div style={styles.detailModalOverlay} onClick={onClose}>
      <div style={styles.detailModalBox} onClick={e => e.stopPropagation()}>
        <div style={styles.detailModalHeader}>
          <div style={{ minWidth: 0 }}>
            <div style={styles.detailModalTitle}>Details: MITRE Technik</div>
            <div style={styles.detailModalSubtitle} title={target.techniqueId}>
              {target.techniqueId}
              {target.tactic ? ` · Taktik: ${target.tactic}` : ''}
              {` · Rules: ${target.ruleCount} · Incidents: ${target.incidentCount}`}
            </div>
          </div>
          <button type="button" onClick={onClose} style={styles.detailModalCloseBtn}>x Schließen</button>
        </div>

        <div style={styles.detailEventList}>
          {isLoading ? (
            <div style={{ color: 'var(--muted-fg)', padding: '1.25rem' }}>Lade Incidents…</div>
          ) : isError ? (
            <div style={{ color: 'var(--danger-fg)', padding: '1.25rem' }}>
              Fehler beim Laden: {getApiErrorMessage(error)}
            </div>
          ) : matchingIncidents.length === 0 ? (
            <div style={{ color: 'var(--muted-fg)', padding: '1.25rem' }}>
              Keine zugeordneten Incidents (Technik ist nur in Regeln vorhanden).
            </div>
          ) : (
            matchingIncidents.map(incident => (
              <div key={incident.id} style={styles.detailEventCard}>
                <div style={styles.detailEventHeader}>
                  <span style={styles.detailEventTs}>{dayjs(incident.last_seen).format('DD.MM.YYYY HH:mm:ss')}</span>
                  <span
                    style={{
                      ...styles.detailEventSeverity,
                      background:
                        incident.severity === 'critical' ? '#ef4444'
                        : incident.severity === 'error' ? '#f97316'
                        : incident.severity === 'warning' ? '#eab308'
                        : incident.severity === 'info' ? '#22c55e'
                        : '#6366f1',
                    }}
                  >
                    {incident.severity}
                  </span>
                  <span style={styles.detailEventService}>Status: {incident.status}</span>
                  <span style={styles.detailEventHost}>Events: {incident.event_count}</span>
                </div>
                <div style={{ padding: '0.6rem 0.75rem 0.4rem 0.75rem', fontWeight: 600 }}>
                  {incident.title}
                </div>
                <div style={styles.detailMetadataWrap}>
                  <div style={styles.detailMetadataRow}>
                    <span style={styles.detailMetadataKey}>ID</span>
                    <span style={styles.detailMetadataVal}>{incident.id}</span>
                  </div>
                  <div style={styles.detailMetadataRow}>
                    <span style={styles.detailMetadataKey}>Erstmals</span>
                    <span style={styles.detailMetadataVal}>{dayjs(incident.first_seen).format('DD.MM.YYYY HH:mm:ss')}</span>
                  </div>
                  {incident.mitre_techniques?.length ? (
                    <div style={styles.detailMetadataRow}>
                      <span style={styles.detailMetadataKey}>Techniken</span>
                      <span style={styles.detailMetadataVal}>{incident.mitre_techniques.join(', ')}</span>
                    </div>
                  ) : null}
                  {incident.mitre_tactic ? (
                    <div style={styles.detailMetadataRow}>
                      <span style={styles.detailMetadataKey}>Taktik</span>
                      <span style={styles.detailMetadataVal}>{incident.mitre_tactic}</span>
                    </div>
                  ) : null}
                  {incident.confidence_rationale ? (
                    <div style={styles.detailMetadataRow}>
                      <span style={styles.detailMetadataKey}>Begründung</span>
                      <span style={styles.detailMetadataVal}>{incident.confidence_rationale}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
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
  return <div style={{ color: 'var(--muted-fg)', padding: '1rem' }}>Lade…</div>
}

function PanelError({ error }: { error: unknown }) {
  return (
    <div style={{ color: 'var(--danger-fg)', padding: '1rem', fontSize: '0.85rem' }}>
      Fehler beim Laden: {getApiErrorMessage(error)}
    </div>
  )
}

function MiniBar({ points }: { points: { ts: string; count: number }[] }) {
  if (!points.length) return <div style={{ color: 'var(--muted-fg)' }}>Keine Daten</div>

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
          stroke="var(--border)" strokeDasharray="3 3" strokeWidth={1}
        />
        {/* grid line at 0 / baseline */}
        <line
          x1={pad.left} y1={pad.top + innerH}
          x2={pad.left + innerW} y2={pad.top + innerH}
          stroke="var(--border)" strokeWidth={1}
        />

        {/* filled area under the line */}
        <polygon
          points={`${x(0)},${pad.top + innerH} ${polyline} ${x(points.length - 1)},${pad.top + innerH}`}
          fill="var(--accent)"
          fillOpacity={0.15}
        />

        {/* hover guide line */}
        {hoveredPoint && hoverState && (
          <line
            x1={hoverState.x}
            y1={pad.top}
            x2={hoverState.x}
            y2={pad.top + innerH}
            stroke="var(--accent)"
            strokeDasharray="4 4"
            strokeWidth={1}
          />
        )}

        {/* the line itself */}
        <polyline
          points={polyline}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={3}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* data-point dots (only when few points) */}
        {points.length <= 30 && points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.count)} r={3} fill="var(--accent)">
            <title>{`${dayjs(p.ts).format('DD.MM HH:mm')}: ${p.count}`}</title>
          </circle>
        ))}

        {/* highlighted hover dot */}
        {hoveredPoint && hoverState && (
          <circle
            cx={hoverState.x}
            cy={hoverState.y}
            r={5}
            fill="var(--surface)"
            stroke="var(--accent)"
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
            fill="var(--muted-fg)"
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
            fill="var(--muted-fg)"
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
  refBtn: { background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted-fg)', borderRadius: 6, padding: '0.35rem 0.75rem', cursor: 'pointer', opacity: 1, fontSize: '0.85rem', whiteSpace: 'nowrap' },
  ingestRow: { display: 'flex', gap: '0.5rem', alignItems: 'center' },
  socToggleWrap: { display: 'flex', gap: '0.45rem', alignItems: 'center', flexWrap: 'wrap' },
  socStatusPill: {
    border: '1px solid var(--border)',
    borderRadius: 999,
    padding: '0.2rem 0.55rem',
    fontSize: '0.74rem',
    fontWeight: 700,
    whiteSpace: 'nowrap',
  },
  socEnableBtn: {
    background: 'color-mix(in srgb, var(--success-fg) 18%, var(--surface))',
    color: 'var(--success-fg)',
    border: '1px solid color-mix(in srgb, var(--success-fg) 52%, var(--border))',
    borderRadius: 6,
    padding: '0.35rem 0.65rem',
    fontSize: '0.78rem',
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  socDisableBtn: {
    background: 'color-mix(in srgb, var(--danger-fg) 14%, var(--surface))',
    color: 'var(--danger-fg)',
    border: '1px solid color-mix(in srgb, var(--danger-fg) 52%, var(--border))',
    borderRadius: 6,
    padding: '0.35rem 0.65rem',
    fontSize: '0.78rem',
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  ingestBtn: {
    background: 'var(--accent)', color: '#fff', border: 'none',
    borderRadius: 8, padding: '0.55rem 1.1rem', cursor: 'pointer', fontWeight: 600, flexShrink: 0, whiteSpace: 'nowrap',
  },
  ingestInfo: {
    background: 'var(--surface)', borderRadius: 8, padding: '0.75rem 1rem',
    marginBottom: '1.5rem', fontSize: '0.85rem', color: 'var(--accent-fg)',
    border: '1px solid var(--border)',
    display: 'flex', flexDirection: 'column', gap: '0.25rem',
  },
  chartTooltip: {
    position: 'absolute',
    zIndex: 20,
    minWidth: 170,
    maxWidth: 220,
    padding: '0.5rem 0.65rem',
    borderRadius: 10,
    border: '1px solid color-mix(in srgb, var(--accent) 35%, var(--border))',
    background: 'color-mix(in srgb, var(--surface) 96%, transparent)',
    boxShadow: '0 14px 30px rgba(2, 6, 23, 0.42)',
    pointerEvents: 'none',
  },
  chartTooltipTime: {
    color: 'var(--muted-fg)',
    fontSize: '0.72rem',
    marginBottom: '0.2rem',
  },
  chartTooltipValue: {
    color: 'var(--accent)',
    fontSize: '0.92rem',
    fontWeight: 700,
  },
  statusWrap: {
    background: 'var(--surface)', borderRadius: 10, padding: '0.8rem 1rem', border: '1px solid var(--border)', marginBottom: '1rem',
  },
  statusTitle: { color: 'var(--muted-fg)', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.6rem' },
  statusGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.6rem' },
  statusCard: { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.65rem 0.75rem' },
  statusName: { color: 'var(--fg)', fontSize: '0.86rem', fontWeight: 600, marginBottom: '0.35rem' },
  statusBadge: { display: 'inline-block', borderRadius: 999, padding: '0.12rem 0.5rem', fontSize: '0.72rem', fontWeight: 700, marginBottom: '0.35rem' },
  statusLine: { color: 'var(--muted-fg)', fontSize: '0.78rem', lineHeight: 1.45 },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.45rem',
    marginBottom: '0.65rem',
  },
  sectionTitle: {
    color: 'var(--muted-fg)',
    fontSize: '0.78rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  kpiRow: { display: 'flex', gap: '1rem', marginBottom: '1.5rem' },
  kpi: { flex: 1, background: 'var(--surface)', borderRadius: 10, padding: '1.25rem 1.5rem', border: '1px solid var(--border)' },
  kpiVal: { fontSize: '2rem', fontWeight: 700, color: 'var(--accent)' },
  kpiLabel: { color: 'var(--muted-fg)', fontSize: '0.85rem', marginTop: '0.25rem' },
  kpiLabelRow: { display: 'flex', alignItems: 'center', gap: '0.35rem', marginTop: '0.25rem' },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' },
  panel: { background: 'var(--surface)', borderRadius: 10, padding: '1.25rem', border: '1px solid var(--border)' },
  panelTitle: { margin: '0 0 1rem 0', fontSize: '0.95rem', color: 'var(--muted-fg)' },
  panelTitleRow: { display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '1rem' },
  panelMetaRow: { display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.65rem' },
  panelMetaLabel: { color: 'var(--muted-fg)', fontSize: '0.76rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' },
  panelMetaValue: { color: 'var(--fg)', fontSize: '0.8rem' },
  ol: { margin: 0, padding: '0 0 0 1.2rem' },
  li: { display: 'flex', marginBottom: '0.4rem', fontSize: '0.82rem', color: 'var(--fg)' },
  count: { background: 'var(--accent-soft)', color: 'var(--accent-fg)', borderRadius: 4, padding: '0 0.4rem', flexShrink: 0 },
  msg: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  topEntryButton: {
    width: '100%',
    border: '1px solid transparent',
    background: 'transparent',
    color: 'inherit',
    display: 'flex',
    gap: '0.75rem',
    alignItems: 'center',
    textAlign: 'left',
    cursor: 'pointer',
    padding: '0.25rem 0.3rem',
    borderRadius: 6,
  },
  detailModalOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(2, 6, 23, 0.64)',
    zIndex: 2600,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '1.25rem',
  },
  detailModalBox: {
    width: 'min(1280px, 96vw)',
    maxHeight: '92vh',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  detailModalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '1rem',
    padding: '0.9rem 1rem',
    borderBottom: '1px solid var(--border)',
  },
  detailModalTitle: { color: 'var(--fg)', fontSize: '0.95rem', fontWeight: 700 },
  detailModalSubtitle: {
    color: 'var(--muted-fg)',
    fontSize: '0.8rem',
    marginTop: '0.2rem',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '76vw',
  },
  detailModalCloseBtn: {
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    color: 'var(--muted-fg)',
    borderRadius: 6,
    padding: '0.4rem 0.7rem',
    cursor: 'pointer',
    flexShrink: 0,
  },
  detailModalFilterRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    flexWrap: 'wrap',
    padding: '0.8rem 1rem',
    borderBottom: '1px solid var(--border)',
  },
  detailFilterLabel: {
    color: 'var(--muted-fg)',
    fontSize: '0.76rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  detailFilterInput: {
    background: 'var(--surface-2)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '0.35rem 0.45rem',
    fontSize: '0.82rem',
  },
  detailFilterBtn: {
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '0.38rem 0.65rem',
    fontSize: '0.8rem',
    cursor: 'pointer',
  },
  detailResetBtn: {
    background: 'var(--surface-2)',
    color: 'var(--muted-fg)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '0.38rem 0.65rem',
    fontSize: '0.8rem',
    cursor: 'pointer',
  },
  detailMetaText: { color: 'var(--muted-fg)', fontSize: '0.78rem', marginLeft: 'auto' },
  detailEventList: {
    overflowY: 'auto',
    padding: '0.9rem',
    background: 'var(--surface-2)',
  },
  detailEventCard: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    marginBottom: '0.7rem',
    overflow: 'hidden',
  },
  detailEventHeader: {
    width: '100%',
    border: 'none',
    background: 'var(--surface)',
    color: 'inherit',
    cursor: 'pointer',
    display: 'grid',
    gridTemplateColumns: '180px 90px 1fr 140px 140px',
    gap: '0.55rem',
    alignItems: 'center',
    padding: '0.7rem 0.75rem 0 0.75rem',
    textAlign: 'left',
  },
  detailEventTs: { color: 'var(--muted-fg)', fontSize: '0.78rem' },
  detailEventSeverity: {
    color: '#fff',
    fontSize: '0.72rem',
    fontWeight: 700,
    borderRadius: 6,
    padding: '0.14rem 0.5rem',
    textTransform: 'uppercase',
    width: 'fit-content',
  },
  detailEventSource: { color: 'var(--accent)', fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  detailEventHost: { color: 'var(--muted-fg)', fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  detailEventService: { color: 'var(--muted-fg)', fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  detailMetadataWrap: {
    borderTop: '1px solid var(--border)',
    marginTop: '0.2rem',
    padding: '0.6rem 0.75rem 0.75rem 0.75rem',
    display: 'grid',
    gap: '0.35rem',
  },
  detailMetadataRow: {
    display: 'grid',
    gridTemplateColumns: '170px 1fr',
    gap: '0.45rem',
    alignItems: 'start',
  },
  detailMetadataKey: {
    color: 'var(--muted-fg)',
    fontSize: '0.74rem',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    fontWeight: 700,
  },
  detailMetadataVal: {
    color: 'var(--fg)',
    fontSize: '0.8rem',
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  bucketSelect: {
    background: 'var(--surface)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '0.35rem 0.55rem',
    fontSize: '0.82rem',
  },
  autoProfileGroup: {
    display: 'inline-flex',
    border: '1px solid var(--border)',
    borderRadius: 8,
    overflow: 'hidden',
    background: 'var(--surface)',
  },
  autoProfileButton: {
    background: 'transparent',
    color: 'var(--muted-fg)',
    border: 'none',
    borderRight: '1px solid var(--border)',
    padding: '0.32rem 0.55rem',
    fontSize: '0.76rem',
    fontWeight: 700,
    cursor: 'pointer',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  autoProfileButtonActive: {
    background: 'var(--accent)',
    color: '#fff',
  },
}
