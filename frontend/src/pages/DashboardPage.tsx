import { useQuery } from '@tanstack/react-query'
import { getTimeseries, getTopErrors, getTopServices, getErrorRate, runIngestion, getSources, uploadImport } from '../lib/requests'
import { useEffect, useRef, useState } from 'react'

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

interface SourceOption {
  id: string       // 'preset:<path>' | 'source:<uuid>' | 'custom:<path>'
  label: string
  path: string
  kind: 'preset' | 'configured' | 'custom'
}

// ─── Source picker dropdown ───────────────────────────────────────────────────
function SourcePicker({
  selected, onChange, onUploadResult,
}: {
  selected: SourceOption[]
  onChange: (v: SourceOption[]) => void
  onUploadResult: (r: any) => void
}) {
  const [open, setOpen] = useState(false)
  const [customInput, setCustomInput] = useState('')
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const { data: configuredSourcesRaw } = useQuery({ queryKey: ['sources'], queryFn: getSources })
  const configuredSources: any[] = Array.isArray(configuredSourcesRaw) ? configuredSourcesRaw : []
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const configuredOptions: SourceOption[] = configuredSources.map((s: any) => ({
    id: `source:${s.id}`,
    label: `${s.name} (${s.config?.path ?? '?'})`,
    path: s.config?.path ?? '',
    kind: 'configured',
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
      label: path,
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
          {configuredOptions.map(opt => (
            <OptionRow key={opt.id} opt={opt} checked={!!selected.find(s => s.id === opt.id)} onToggle={toggle} />
          ))}

          {/* Presets */}
          <div style={pickerStyles.groupHeader}>Standard-Log-Dateien</div>
          {presetOptions.map(opt => (
            <OptionRow key={opt.id} opt={opt} checked={!!selected.find(s => s.id === opt.id)} onToggle={toggle} />
          ))}

          {/* Custom input */}
          <div style={pickerStyles.groupHeader}>Eigener Pfad</div>
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
                    onUploadResult(r)
                    setOpen(false)
                  } catch (err: any) {
                    onUploadResult({ error: err?.response?.data?.detail ?? err?.message ?? 'Upload fehlgeschlagen' })
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
  const ts = useQuery({ queryKey: ['timeseries'], queryFn: () => getTimeseries({ bucket: '5m' }) })
  const errs = useQuery({ queryKey: ['top-errors'], queryFn: getTopErrors })
  const svcs = useQuery({ queryKey: ['top-services'], queryFn: getTopServices })
  const rate = useQuery({ queryKey: ['error-rate'], queryFn: getErrorRate })

  const [selectedSources, setSelectedSources] = useState<SourceOption[]>([])
  const [ingesting, setIngesting] = useState(false)
  const [ingestResult, setIngestResult] = useState<any>(null)
  const [ingestError, setIngestError] = useState<string | null>(null)
  const [uploadResult, setUploadResult] = useState<any>(null)

  function handleUploadResult(r: any) {
    setUploadResult(r)
    if (!r?.error) {
      ts.refetch(); errs.refetch(); svcs.refetch(); rate.refetch()
    }
  }

  async function handleIngest() {
    setIngesting(true)
    setIngestError(null)
    setIngestResult(null)
    try {
      const configuredIds = selectedSources
        .filter(s => s.kind === 'configured')
        .map(s => s.id.replace('preset:', '').replace('source:', ''))
      const extraPaths = selectedSources
        .filter(s => s.kind === 'preset' || s.kind === 'custom')
        .map(s => s.path)

      const r = await runIngestion({
        sourceIds: configuredIds.length ? configuredIds : undefined,
        extraPaths: extraPaths.length ? extraPaths : undefined,
      })
      setIngestResult(r)
      ts.refetch(); errs.refetch(); svcs.refetch(); rate.refetch()
    } catch (e: any) {
      const msg = e?.response?.data?.detail ?? e?.message ?? 'Unbekannter Fehler'
      setIngestError(`Fehler: ${msg} (Status ${e?.response?.status ?? '?'})`)
    } finally {
      setIngesting(false)
    }
  }

  const rr = rate.data
  const errorRate = rr ? (rr.total_events > 0 ? (rr.error_rate * 100).toFixed(1) : '0.0') : '–'
  const totalEvents = rr?.total_events ?? '–'

  return (
    <div>
      <div style={styles.header}>
        <h2 style={styles.h2}>Dashboard</h2>
        <div style={styles.ingestRow}>
          <SourcePicker selected={selectedSources} onChange={setSelectedSources} onUploadResult={handleUploadResult} />
          <button onClick={handleIngest} disabled={ingesting} style={styles.ingestBtn}>
            {ingesting ? '⏳ Ingestiere…' : '▶ Ingestion starten'}
          </button>
        </div>
      </div>

      {ingestError && (
        <div style={{ ...styles.ingestInfo, background: '#450a0a', color: '#f87171' }}>
          {ingestError}
        </div>
      )}

      {ingestResult && (
        <div style={styles.ingestInfo}>
          {ingestResult.results?.map((r: any, i: number) => (
            <div key={i}>
              {r.skipped
                ? `⚠ ${r.source_id}: ${r.reason}`
                : r.adhoc
                  ? `📁 ${r.source_id}: ${r.lines_readable} Zeilen lesbar (nicht ingested — Quelle zuerst konfigurieren)`
                  : `✓ ${r.source_id}: ${r.lines_ingested} Zeilen, ${r.events_created ?? 0} Events`}
            </div>
          ))}
        </div>
      )}

      {uploadResult && (
        <div style={{ ...styles.ingestInfo, background: uploadResult.error ? '#450a0a' : '#0f2d1a', color: uploadResult.error ? '#f87171' : '#86efac', position: 'relative' }}>
          <button onClick={() => setUploadResult(null)} style={{ position: 'absolute', top: '0.4rem', right: '0.5rem', background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '1rem' }}>✕</button>
          {uploadResult.error ? (
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

      <div style={styles.kpiRow}>
        <KpiCard title="Gesamt Events" value={String(totalEvents)} />
        <KpiCard title="Fehlerrate" value={`${errorRate}%`} />
        <KpiCard title="Fehler" value={String(rr?.error_events ?? '–')} />
      </div>

      <div style={styles.grid}>
        <Panel title="Events / 5 Min (letzte Stunde)">
          {ts.data ? <MiniBar points={ts.data.points} /> : <Spinner />}
        </Panel>

        <Panel title="Top Fehler-Meldungen">
          {errs.data ? (
            <ol style={styles.ol}>
              {errs.data.items.slice(0, 8).map((e: any, i: number) => (
                <li key={i} style={styles.li}>
                  <span style={styles.count}>{e.count}</span>
                  <span style={styles.msg}>{(e.key ?? e.message ?? '').slice(0, 80)}</span>
                </li>
              ))}
              {!errs.data.items.length && <div style={{ color: '#64748b', fontSize: '0.85rem' }}>Keine Fehler-Events</div>}
            </ol>
          ) : <Spinner />}
        </Panel>

        <Panel title="Top Services">
          {svcs.data ? (
            <ol style={styles.ol}>
              {svcs.data.items.slice(0, 8).map((s: any, i: number) => (
                <li key={i} style={styles.li}>
                  <span style={styles.count}>{s.count}</span>
                  <span style={styles.msg}>{s.service ?? '(unbekannt)'}</span>
                </li>
              ))}
              {!svcs.data.items.length && <div style={{ color: '#64748b', fontSize: '0.85rem' }}>Keine Service-Daten</div>}
            </ol>
          ) : <Spinner />}
        </Panel>
      </div>
    </div>
  )
}

function KpiCard({ title, value }: { title: string; value: string }) {
  return (
    <div style={styles.kpi}>
      <div style={styles.kpiVal}>{value}</div>
      <div style={styles.kpiLabel}>{title}</div>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={styles.panel}>
      <h3 style={styles.panelTitle}>{title}</h3>
      {children}
    </div>
  )
}

function Spinner() {
  return <div style={{ color: '#64748b', padding: '1rem' }}>Lade\u2026</div>
}

function MiniBar({ points }: { points: { ts: string; count: number }[] }) {
  if (!points.length) return <div style={{ color: '#64748b' }}>Keine Daten</div>
  const max = Math.max(...points.map(p => p.count), 1)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 80 }}>
      {points.map((p, i) => (
        <div key={i} title={`${p.ts}: ${p.count}`}
          style={{ flex: 1, minWidth: 4, height: `${(p.count / max) * 100}%`, background: '#3b82f6', borderRadius: 2 }}
        />
      ))}
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
  kpiRow: { display: 'flex', gap: '1rem', marginBottom: '1.5rem' },
  kpi: { flex: 1, background: '#1e293b', borderRadius: 10, padding: '1.25rem 1.5rem', border: '1px solid #334155' },
  kpiVal: { fontSize: '2rem', fontWeight: 700, color: '#93c5fd' },
  kpiLabel: { color: '#64748b', fontSize: '0.85rem', marginTop: '0.25rem' },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' },
  panel: { background: '#1e293b', borderRadius: 10, padding: '1.25rem', border: '1px solid #334155' },
  panelTitle: { margin: '0 0 1rem 0', fontSize: '0.95rem', color: '#94a3b8' },
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
