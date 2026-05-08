import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteSource,
  getErrorRate,
  getSources,
  getTimeseries,
  getTopErrors,
  getTopServices,
  runIngestion,
  uploadImport,
  type IngestionRunEntry,
  type IngestionRunResponse,
  type MetricsFilter,
  type SourceResponse,
  type TimeRange,
  type TopErrorItem,
  type TopServiceItem,
  type UploadImportResponse,
} from '../lib/requests'
import { useEffect, useRef, useState } from 'react'
import dayjs from 'dayjs'
import { getApiErrorMessage } from '../lib/errors'
import HelpTip from '../components/HelpTip'
import { type SourceOption } from '../ctx/SourceFilterContext.shared'
import { useSourceFilter } from '../ctx/useSourceFilter'

// ─── Time range presets ───────────────────────────────────────────────────────
const TIME_PRESETS: { label: string; hours: number }[] = [
  { label: '1 h',  hours: 1 },
  { label: '6 h',  hours: 6 },
  { label: '24 h', hours: 24 },
  { label: '7 d',  hours: 168 },
  { label: '30 d', hours: 720 },
  { label: 'Alle', hours: 0 },
]

// ─── Preset log paths ────────────────────────────────────────────────────────
const PRESET_PATHS = [
  { label: 'syslog',          path: '/var/log/syslog' },
  { label: 'auth.log',        path: '/var/log/auth.log' },
  { label: 'kern.log',        path: '/var/log/kern.log' },
  { label: 'dpkg.log',        path: '/var/log/dpkg.log' },
  { label: 'Nginx access',    path: '/var/log/nginx/access.log' },
  { label: 'Nginx error',     path: '/var/log/nginx/error.log' },
  { label: 'Apache access',   path: '/var/log/apache2/access.log' },
  { label: 'Apache error',    path: '/var/log/apache2/error.log' },
  { label: 'MySQL error',     path: '/var/log/mysql/error.log' },
  { label: 'PostgreSQL',      path: '/var/log/postgresql/postgresql-16-main.log' },
  { label: 'journald (boot)', path: '/var/log/boot.log' },
]

const PRESET_PATH_SET = new Set(PRESET_PATHS.map(p => p.path))

type UploadResultState = UploadImportResponse | { error: string }

function isUploadError(result: UploadResultState): result is { error: string } {
  return 'error' in result
}

function buildTimeRange(rangeHours: number): TimeRange | undefined {
  if (rangeHours === 0) return undefined
  const now = new Date()
  return {
    from: new Date(now.getTime() - rangeHours * 3600_000).toISOString(),
    to: now.toISOString(),
  }
}

// ─── Source picker dropdown ───────────────────────────────────────────────────
function SourcePicker({
  selected, onChange, onUploadResult, customSources, onRemoveCustom,
}: {
  selected: SourceOption[]
  onChange: (v: SourceOption[]) => void
  onUploadResult: (r: UploadResultState) => void | Promise<void>
  customSources: SourceOption[]   // externally tracked custom/uploaded entries
  onRemoveCustom: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [customInput, setCustomInput] = useState('')
  const [uploading, setUploading] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const { data: configuredSources = [] } = useQuery({ queryKey: ['sources'], queryFn: getSources })
  const qc = useQueryClient()
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const configuredOptions: SourceOption[] = configuredSources
    .filter((s: SourceResponse) => {
      const origin = s.config?.source_origin
      // Exclude sources that were auto-created from preset selection
      if (origin === 'preset') return false
      // Exclude sources whose path matches a preset path (legacy entries without origin)
      if (!origin && PRESET_PATH_SET.has(s.config?.path ?? '')) return false
      return true
    })
    .map((s: SourceResponse) => ({
      id: `source:${s.id}`,
      label: s.name,
      path: s.config?.path ?? '',
      kind: 'configured' as const,
    }))

  const presetOptions: SourceOption[] = PRESET_PATHS.map(p => ({
    id: `preset:${p.path}`,
    label: p.label,
    path: p.path,
    kind: 'preset',
  }))

  function toggle(opt: SourceOption) {
    const idx = selected.findIndex(s => s.id === opt.id)
    if (idx >= 0) onChange(selected.filter((_, i) => i !== idx))
    else onChange([...selected, opt])
  }

  function addCustom() {
    const path = customInput.trim()
    if (!path) return
    const opt: SourceOption = {
      id: `custom:${path}`,
      label: path.split('/').pop() || path,
      path,
      kind: 'custom',
    }
    if (!selected.find(s => s.id === opt.id)) onChange([...selected, opt])
    setCustomInput('')
  }

  const label = selected.length === 0
    ? 'Alle konfigurierten Quellen'
    : selected.length === 1
      ? selected[0].label
      : `${selected.length} Quellen gewählt`

  return (
    <div ref={ref} style={pickerStyles.wrap}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={pickerStyles.trigger}
        title="Quellen wählen"
      >
        <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <span style={{ flexShrink: 0, marginLeft: '0.4rem' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={pickerStyles.dropdown}>
          <div style={pickerStyles.helperNote}>
            Konfigurierte Quellen sind dauerhaft in der App hinterlegt. Standard- und eigene Pfade erweitern den aktuellen Analysekontext nur fuer deine laufende Arbeit.
          </div>
          {/* Clear selection */}
          <div
            style={{ ...pickerStyles.option, color: '#64748b', borderBottom: '1px solid #334155', paddingBottom: '0.5rem', marginBottom: '0.25rem' }}
            onClick={() => onChange([])}
          >
            ✕ Auswahl zurücksetzen (alle aktivierten)
          </div>

          {/* Configured sources */}
          {configuredOptions.length > 0 && (
            <div style={pickerStyles.groupHeader}>Konfigurierte Quellen</div>
          )}
          {configuredOptions.map(opt => {
            const rawId = opt.id.replace('source:', '')
            const isPending = pendingDeleteId === rawId
            return (
              <div key={opt.id} style={{ ...pickerStyles.option, justifyContent: 'space-between' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, cursor: 'pointer', minWidth: 0 }}>
                  <input
                    type="checkbox"
                    checked={!!selected.find(s => s.id === opt.id)}
                    onChange={() => toggle(opt)}
                    style={{ accentColor: '#3b82f6', flexShrink: 0 }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.label}</span>
                  <span style={{ color: '#22c55e', fontSize: '0.7rem', flexShrink: 0 }}>●</span>
                </label>
                {isPending ? (
                  <div style={{ display: 'flex', gap: '0.2rem', alignItems: 'center', flexShrink: 0 }}>
                    <span style={{ fontSize: '0.72rem', color: '#fca5a5' }}>Löschen?</span>
                    <button
                      onClick={async e => {
                        e.stopPropagation()
                        setPendingDeleteId(null)
                        await deleteSource(rawId)
                        qc.invalidateQueries({ queryKey: ['sources'] })
                        onChange(selected.filter(s => s.id !== opt.id))
                      }}
                      style={{ background: 'none', border: '1px solid #ef4444', color: '#ef4444', cursor: 'pointer', fontSize: '0.72rem', borderRadius: 4, padding: '1px 5px' }}
                    >Ja</button>
                    <button
                      onClick={e => { e.stopPropagation(); setPendingDeleteId(null) }}
                      style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '0.72rem', padding: '1px 3px' }}
                    >Abbrechen</button>
                  </div>
                ) : (
                  <button
                    onClick={e => { e.stopPropagation(); setPendingDeleteId(rawId) }}
                    title="Quelle löschen"
                    style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.85rem', padding: '0 0.15rem', flexShrink: 0, opacity: 0.6 }}
                  >🗑</button>
                )}
              </div>
            )
          })}

          {/* Presets */}
          <div style={pickerStyles.groupHeader}>Standard-Log-Dateien</div>
          {presetOptions.map(opt => (
            <OptionRow key={opt.id} opt={opt} checked={!!selected.find(s => s.id === opt.id)} onToggle={toggle} />
          ))}

          {/* Custom / uploaded sources */}
          {customSources.length > 0 && (
            <>
              <div style={pickerStyles.groupHeader}>Eigene / Hochgeladene Quellen</div>
              {customSources.map(opt => (
                <div key={opt.id} style={{ ...pickerStyles.option, justifyContent: 'space-between' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={!!selected.find(s => s.id === opt.id)}
                      onChange={() => toggle(opt)}
                      style={{ accentColor: '#3b82f6', flexShrink: 0 }}
                    />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.label}</span>
                  </label>
                  <button
                    onClick={e => { e.stopPropagation(); onRemoveCustom(opt.id) }}
                    title="Entfernen"
                    style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.9rem', padding: '0 0.2rem', flexShrink: 0 }}
                  >✕</button>
                </div>
              ))}
            </>
          )}

          {/* Add custom path */}
          <div style={pickerStyles.groupHeader}>Eigener Pfad hinzufügen</div>
          <div style={pickerStyles.customRow}>
            <input
              value={customInput}
              onChange={e => setCustomInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addCustom()}
              placeholder="/var/log/meinlog.log"
              style={pickerStyles.customInput}
            />
            <button onClick={addCustom} style={pickerStyles.addBtn}>+</button>
          </div>

          {/* File upload */}
          <div style={{ borderTop: '1px solid #334155', marginTop: '0.5rem', paddingTop: '0.5rem' }}>
            <div style={pickerStyles.groupHeader}>Datei hochladen</div>
            <div style={{ padding: '0.35rem 0.5rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <input ref={fileRef} type="file" accept=".log,.txt,.csv,text/*" style={{ display: 'none' }}
                onChange={async e => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  setUploading(true)
                  try {
                    const r = await uploadImport(file)
                    await onUploadResult(r)
                    setOpen(false)
                  } catch (error: unknown) {
                    await onUploadResult({ error: getApiErrorMessage(error, 'Upload fehlgeschlagen') })
                  } finally {
                    setUploading(false)
                    if (fileRef.current) fileRef.current.value = ''
                  }
                }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                style={{ ...pickerStyles.addBtn, width: '100%', padding: '0.4rem' }}
              >
                {uploading ? 'Importiere…' : '📂 Datei wählen & importieren'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function OptionRow({ opt, checked, onToggle }: { opt: SourceOption; checked: boolean; onToggle: (o: SourceOption) => void }) {
  return (
    <label style={pickerStyles.option}>
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(opt)}
        style={{ accentColor: '#3b82f6', flexShrink: 0 }}
      />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {opt.label}
      </span>
      {opt.kind === 'configured' && (
        <span style={{ color: '#22c55e', fontSize: '0.7rem', flexShrink: 0 }}>●</span>
      )}
    </label>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { filter, setFilter: setGlobalSourceFilter, selectedSources, setSelectedSources, customSources, setCustomSources } = useSourceFilter()
  const [rangeHours, setRangeHours] = useState(filter.rangeHours) // restored from context on re-mount
  const [ingesting, setIngesting] = useState(false)
  const [ingestResult, setIngestResult] = useState<IngestionRunResponse | null>(null)
  const [ingestError, setIngestError] = useState<string | null>(null)
  const [uploadResult, setUploadResult] = useState<UploadResultState | null>(null)

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
    setIngestResult(null)
    try {
      const result = await runIngestion({
        sourceIds: activeSourceIds,
        extraEntries: activeSources
          .filter(source => source.kind === 'preset' || source.kind === 'custom')
          .map(source => ({ path: source.path, origin: source.kind === 'preset' ? 'preset' as const : 'custom' as const })),
      })
      setIngestResult(result)
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
    setRangeHours(nextRangeHours)
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
    ? { sourceIds: selectedSourceIds, sourcePaths: selectedSourcePaths }
    : undefined

  const sourceKey = `${selectedSourceIds.join('|')}::${selectedSourcePaths.join('|')}`
  const bucket = rangeHours === 0 || rangeHours > 24 ? '1h' : rangeHours <= 6 ? '5m' : '15m'

  const ts = useQuery({
    queryKey: ['timeseries', rangeHours, sourceKey],
    queryFn: () => {
      const timeRange = buildTimeRange(rangeHours)
      return getTimeseries({
        bucket,
        ...(timeRange ? { from: timeRange.from, to: timeRange.to } : {}),
        ...(metricsFilter?.sourceIds?.length ? { source_ids: metricsFilter.sourceIds.join(',') } : {}),
        ...(metricsFilter?.sourcePaths?.length ? { source_paths: metricsFilter.sourcePaths.join(',') } : {}),
      })
    },
    enabled: selectedSources.length > 0,
  })
  const errs = useQuery({
    queryKey: ['top-errors', rangeHours, sourceKey],
    queryFn: () => getTopErrors(buildTimeRange(rangeHours), metricsFilter),
    enabled: selectedSources.length > 0,
  })
  const svcs = useQuery({
    queryKey: ['top-services', rangeHours, sourceKey],
    queryFn: () => getTopServices(buildTimeRange(rangeHours), metricsFilter),
    enabled: selectedSources.length > 0,
  })
  const rate = useQuery({
    queryKey: ['error-rate', rangeHours, sourceKey],
    queryFn: () => getErrorRate(buildTimeRange(rangeHours), metricsFilter),
    enabled: selectedSources.length > 0,
  })

  function refetchAll() { ts.refetch(); errs.refetch(); svcs.refetch(); rate.refetch() }

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

  return (
    <div>
      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <h2 style={styles.h2}>Dashboard</h2>
          <HelpTip content="Hier waehlst du Quellen und Zeitfenster fuer den aktuellen Analysekontext. Alle Metriken auf dieser Seite reagieren direkt auf diese Auswahl." ariaLabel="Dashboard erklaeren" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
            {TIME_PRESETS.map(p => (
              <button
                key={p.hours}
                onClick={() => handleRangeHoursChange(p.hours)}
                style={{
                  padding: '0.25rem 0.6rem', fontSize: '0.8rem', borderRadius: '0.375rem',
                  border: '1px solid', cursor: 'pointer',
                  background: rangeHours === p.hours ? '#3b82f6' : '#1e293b',
                  color: rangeHours === p.hours ? '#fff' : '#94a3b8',
                  borderColor: rangeHours === p.hours ? '#3b82f6' : '#334155',
                }}
              >{p.label}</button>
            ))}
            <HelpTip content="Das Zeitfenster steuert, wie weit die Metriken in die Vergangenheit schauen. 'Alle' verwendet den kompletten verfuegbaren Datenbestand." ariaLabel="Zeitfenster erklaeren" />
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

      {ingestResult && (
        <div style={styles.ingestInfo}>
          {ingestResult.results?.map((result: IngestionRunEntry, i: number) => {
            const sourceLabel = result.path || result.source_name
            const label = sourceLabel ? sourceLabel.split('/').pop() : result.source_id?.slice(0, 16)
            return (
              <div key={i}>
                {result.skipped
                  ? `⚠ ${label}: ${result.reason}`
                  : `✓ ${label}: ${result.lines_ingested ?? 0} Zeilen, ${result.events_created ?? 0} Events`}
              </div>
            )
          })}
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
            <Panel title={`Events / ${bucket} (${rangeHours === 0 ? 'alle' : TIME_PRESETS.find(p => p.hours === rangeHours)?.label ?? ''})`} help="Die Balken zeigen, wie viele Events pro Zeitintervall eingegangen sind. Hoehere Balken markieren Lastspitzen oder Stoerungsphasen.">
              {ts.data ? <MiniBar points={ts.data.points} /> : <Spinner />}
            </Panel>

            <Panel title="Top Fehler-Meldungen" help="Hier siehst du die haeufigsten Fehlermeldungen im aktuellen Datenfenster. Das hilft beim Clustern wiederkehrender Stoerungen.">
              {errs.data ? (
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
  return <div style={{ color: '#64748b', padding: '1rem' }}>Lade\u2026</div>
}

function MiniBar({ points }: { points: { ts: string; count: number }[] }) {
  if (!points.length) return <div style={{ color: '#64748b' }}>Keine Daten</div>

  const W = 400
  const H = 80
  const pad = { top: 6, right: 4, bottom: 18, left: 28 }
  const innerW = W - pad.left - pad.right
  const innerH = H - pad.top - pad.bottom

  const max = Math.max(...points.map(p => p.count), 1)

  const x = (i: number) => pad.left + (i / (points.length - 1 || 1)) * innerW
  const y = (v: number) => pad.top + innerH - (v / max) * innerH

  const polyline = points.map((p, i) => `${x(i)},${y(p.count)}`).join(' ')

  // Y-axis: 0 and max labels
  const yLabels = [
    { val: max, yPos: pad.top },
    { val: 0,   yPos: pad.top + innerH },
  ]

  // X-axis: first and last label
  const xLabels = points.length > 1
    ? [
        { label: dayjs(points[0].ts).format('HH:mm'), xPos: pad.left },
        { label: dayjs(points[points.length - 1].ts).format('HH:mm'), xPos: pad.left + innerW },
      ]
    : []

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: 80, overflow: 'visible' }}
      aria-label="Zeitreihen-Liniendiagramm"
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

      {/* the line itself */}
      <polyline
        points={polyline}
        fill="none"
        stroke="#3b82f6"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* data-point dots (only when few points) */}
      {points.length <= 30 && points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.count)} r={2.5} fill="#3b82f6">
          <title>{`${dayjs(p.ts).format('DD.MM HH:mm')}: ${p.count}`}</title>
        </circle>
      ))}

      {/* Y-axis labels */}
      {yLabels.map(({ val, yPos }) => (
        <text
          key={yPos}
          x={pad.left - 4}
          y={yPos}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={9}
          fill="#64748b"
        >
          {val}
        </text>
      ))}

      {/* X-axis labels */}
      {xLabels.map(({ label, xPos }, i) => (
        <text
          key={i}
          x={xPos}
          y={H - 2}
          textAnchor={i === 0 ? 'start' : 'end'}
          fontSize={9}
          fill="#64748b"
        >
          {label}
        </text>
      ))}
    </svg>
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
  ol: { margin: 0, padding: '0 0 0 1.2rem' },
  li: { display: 'flex', gap: '0.75rem', marginBottom: '0.4rem', fontSize: '0.82rem', color: '#f1f5f9' },
  count: { background: '#1e3a5f', color: '#93c5fd', borderRadius: 4, padding: '0 0.4rem', flexShrink: 0 },
  msg: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
}

const pickerStyles: Record<string, React.CSSProperties> = {
  wrap: { position: 'relative', minWidth: 240, maxWidth: 360 },
  trigger: {
    display: 'flex', alignItems: 'center', width: '100%',
    background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155',
    borderRadius: 8, padding: '0.5rem 0.75rem', cursor: 'pointer', fontSize: '0.88rem',
  },
  dropdown: {
    position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 100,
    background: '#1e293b', border: '1px solid #334155', borderRadius: 10,
    boxShadow: '0 8px 32px #0006', padding: '0.5rem', minWidth: 320, maxHeight: 380,
    overflowY: 'auto',
  },
  helperNote: {
    color: '#94a3b8',
    fontSize: '0.76rem',
    lineHeight: 1.45,
    padding: '0.45rem 0.55rem 0.65rem',
    borderBottom: '1px solid #334155',
    marginBottom: '0.35rem',
  },
  groupHeader: {
    color: '#475569', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase',
    padding: '0.4rem 0.5rem 0.2rem',
  },
  option: {
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    padding: '0.35rem 0.5rem', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem',
    color: '#f1f5f9',
  },
  customRow: { display: 'flex', gap: '0.4rem', padding: '0.35rem 0.5rem' },
  customInput: {
    flex: 1, background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155',
    borderRadius: 6, padding: '0.35rem 0.6rem', fontSize: '0.83rem',
  },
  addBtn: {
    background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6,
    padding: '0.35rem 0.65rem', cursor: 'pointer', fontWeight: 700,
  },
}
