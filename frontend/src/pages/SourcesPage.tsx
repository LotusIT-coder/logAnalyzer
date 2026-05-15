import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getSources, createSource, testSource, patchSource, deleteSource, uploadImport, getSourceIngestionStatus, type SourceResponse, type SourceTestResponse, type UploadImportResponse, type SourceIngestionStatus } from '../lib/requests'
import { useEffect, useRef, useState } from 'react'
import { getApiBase } from '../lib/api'
import HelpTip from '../components/HelpTip'
import { getApiErrorMessage } from '../lib/errors'
import dayjs from 'dayjs'

type UploadResultState = UploadImportResponse | { error: string }
type SourceKind = 'file' | 'syslog' | 'journald' | 'docker' | 'filebeat' | 'winlogbeat' | 'elastic_agent'
const PATH_BASED_SOURCE_TYPES = new Set(['file', 'syslog', 'docker', 'filebeat', 'winlogbeat', 'elastic_agent'])

function isPathBasedSourceType(sourceType: string): boolean {
  return PATH_BASED_SOURCE_TYPES.has(sourceType)
}

function isUploadError(result: UploadResultState): result is { error: string } {
  return 'error' in result
}

function describeSource(source: SourceResponse) {
  if (source.type === 'journald' && !source.config?.path) {
    return source.config?.boot_only === false ? 'systemd-journal (alle Boots)' : 'systemd-journal (aktueller Boot)'
  }
  return source.config?.path ?? '-'
}

function formatSourceHealthAge(timestamp?: string | null): string {
  if (!timestamp) return 'nie'
  const seconds = Math.max(0, dayjs().diff(dayjs(timestamp), 'second'))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

function sourceHealthTone(status?: SourceIngestionStatus): { bg: string; fg: string; text: string } {
  if (!status?.last_seen_at) {
    return { bg: 'color-mix(in srgb, var(--danger-fg) 16%, var(--surface))', fg: 'var(--danger-fg)', text: 'keine Events' }
  }
  const ageMs = Date.now() - dayjs(status.last_seen_at).valueOf()
  if (ageMs > 24 * 3600_000) {
    return { bg: 'color-mix(in srgb, var(--danger-fg) 16%, var(--surface))', fg: 'var(--danger-fg)', text: '>24h alt' }
  }
  if (ageMs > 2 * 3600_000) {
    return { bg: 'color-mix(in srgb, var(--warning-fg) 16%, var(--surface))', fg: 'var(--warning-fg)', text: 'verzögert' }
  }
  return { bg: 'color-mix(in srgb, var(--success-fg) 16%, var(--surface))', fg: 'var(--success-fg)', text: 'aktuell' }
}

// ─── Edit Modal ───────────────────────────────────────────────────────────────
function EditSourceModal({ source, onClose, onSaved }: { source: SourceResponse; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(source.name ?? '')
  const [path, setPath] = useState(source.config?.path ?? '')
  const [pathRegex, setPathRegex] = useState(Boolean(source.config?.path_regex))
  const [bootOnly, setBootOnly] = useState(source.config?.boot_only !== false)
  const [enabled, setEnabled] = useState(source.enabled ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const isJournald = source.type === 'journald' && !source.config?.path

  async function handleSave() {
    setSaving(true)
    setError('')
    try {
      await patchSource(source.id, {
        name,
        config: isJournald
          ? { ...source.config, boot_only: bootOnly }
          : { ...source.config, path, path_regex: pathRegex },
        enabled,
      })
      onSaved()
      onClose()
    } catch (error: unknown) {
      setError(getApiErrorMessage(error, 'Fehler beim Speichern.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={modal.overlay} onClick={onClose}>
      <div style={{ ...modal.box, height: 'auto', maxWidth: 540, padding: '1.5rem' }} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 1rem 0', fontSize: '1rem', color: 'var(--fg)' }}>Quelle bearbeiten</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={styles.field}>
            <label style={styles.label}>Name</label>
            <input value={name} onChange={e => setName(e.target.value)} style={styles.input} />
          </div>
          {isJournald ? (
            <label style={styles.inlineCheckbox}>
              <input type="checkbox" checked={bootOnly} onChange={e => setBootOnly(e.target.checked)} />
              Nur aktuellen Boot aus dem systemd-Journal lesen
            </label>
          ) : (
            <>
              <div style={styles.field}>
                <label style={styles.label}>Dateipfad</label>
                <input value={path} onChange={e => setPath(e.target.value)} style={styles.input} />
              </div>
              <label style={styles.inlineCheckbox}>
                <input type="checkbox" checked={pathRegex} onChange={e => setPathRegex(e.target.checked)} />
                Dateipfad als Regex behandeln (Dateiname)
              </label>
            </>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.88rem', color: 'var(--muted-fg)', cursor: 'pointer' }}>
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
            Aktiv
          </label>
        </div>
        {error && <div style={{ color: 'var(--danger-fg)', fontSize: '0.82rem', marginTop: '0.5rem' }}>{error}</div>}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.25rem' }}>
          <button onClick={handleSave} disabled={saving || !name || (!isJournald && !path)} style={styles.saveBtn}>
            {saving ? 'Speichere...' : 'Speichern'}
          </button>
          <button onClick={onClose} style={modal.ctrlBtn}>Abbrechen</button>
        </div>
      </div>
    </div>
  )
}

// ─── Live-Tail Modal ──────────────────────────────────────────────────────────
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
            <span style={{ fontSize: '0.75rem', color: 'var(--muted-fg)' }}>{connected ? 'verbunden' : 'getrennt'}</span>
            {paused && <span style={{ fontSize: '0.72rem', color: 'var(--warning-fg)', fontWeight: 700 }}>PAUSIERT</span>}
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
            <button onClick={onClose} style={{ ...modal.ctrlBtn, color: 'var(--danger-fg)' }}>x Schliessen</button>
          </div>
        </div>

        {error && <div style={{ color: 'var(--danger-fg)', padding: '0.5rem 1rem', fontSize: '0.82rem' }}>{error}</div>}

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
            <div style={{ color: 'var(--muted-fg)', padding: '1rem' }}>
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
  const { data, isLoading } = useQuery({ queryKey: ['sources'], queryFn: getSources })
  const sources: SourceResponse[] = Array.isArray(data) ? data : []
  const sourceIds = sources.map(source => source.id)
  const sourceStatus = useQuery({
    queryKey: ['sources-status', sourceIds.join('|')],
    queryFn: () => getSourceIngestionStatus(sourceIds),
    enabled: sourceIds.length > 0,
    staleTime: 10_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
  })
  const sourceStatusById = new Map<string, SourceIngestionStatus>((sourceStatus.data ?? []).map(entry => [entry.source_id, entry]))
  const [showNew, setShowNew] = useState(false)
  const [sourceType, setSourceType] = useState<SourceKind>('file')
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [pathRegex, setPathRegex] = useState(false)
  const [bootOnly, setBootOnly] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [testResults, setTestResults] = useState<Record<string, SourceTestResponse>>({})
  const [tailSource, setTailSource] = useState<SourceResponse | null>(null)
  const [editSource, setEditSource] = useState<SourceResponse | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [uploadResult, setUploadResult] = useState<UploadResultState | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleCreate() {
    setSaving(true)
    try {
      await createSource({
        name,
        type: sourceType,
        config: sourceType === 'journald' ? { boot_only: bootOnly } : { path, path_regex: pathRegex },
        enabled: true,
      })
      qc.invalidateQueries({ queryKey: ['sources'] })
      setShowNew(false)
      setSourceType('file')
      setName('')
      setPath('')
      setPathRegex(false)
      setBootOnly(true)
    } finally {
      setSaving(false)
    }
  }

  async function handleUpload(file: File) {
    setUploading(true)
    try {
      const result = await uploadImport(file)
      setUploadResult(result)
      setShowNew(false)
      qc.invalidateQueries({ queryKey: ['sources'] })
    } catch (error: unknown) {
      setUploadResult({ error: getApiErrorMessage(error, 'Upload fehlgeschlagen.') })
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
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

  return (
    <div>
      {tailSource && <LiveTailModal source={tailSource} onClose={() => setTailSource(null)} />}
      {editSource && <EditSourceModal source={editSource} onClose={() => setEditSource(null)} onSaved={() => qc.invalidateQueries({ queryKey: ['sources'] })} />}

      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <h2 style={styles.h2}>Log-Quellen</h2>
          <HelpTip content="Hier verwaltest du die angebundenen Logdateien. Quellen koennen getestet, live beobachtet, bearbeitet und bei Bedarf entfernt werden." ariaLabel="Log-Quellen erklaeren" />
        </div>
        <button onClick={() => setShowNew(v => !v)} style={styles.addBtn}>
          {showNew ? 'x Abbrechen' : '+ Neue Quelle'}
        </button>
      </div>

      <div style={{ ...styles.liveHint, display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <span>
          Live-Ansicht wird pro Quelle gestartet: bei der gewuenschten Quelle auf <strong>Live-Ansicht</strong> klicken.
        </span>
        <HelpTip content="Die Live-Ansicht zeigt neu eintreffende Logzeilen der gewaehlten Datei in Echtzeit. Das ist besonders hilfreich nach Parser-, Ingestion- oder Quellenaenderungen." ariaLabel="Live-Ansicht der Quellen erklaeren" />
      </div>

      {uploadResult && (
        <div style={{ ...styles.uploadInfo, background: isUploadError(uploadResult) ? 'color-mix(in srgb, var(--danger-fg) 16%, var(--surface))' : 'color-mix(in srgb, var(--success-fg) 16%, var(--surface))', color: isUploadError(uploadResult) ? 'var(--danger-fg)' : 'var(--success-fg)', position: 'relative' }}>
          <button onClick={() => setUploadResult(null)} style={styles.dismissBtn}>✕</button>
          {isUploadError(uploadResult) ? (
            <div>Upload-Fehler: {uploadResult.error}</div>
          ) : (
            <>
              <div>📄 Importiert: {uploadResult.lines_ingested} Zeilen · {uploadResult.events_created} Events</div>
              <div style={{ marginTop: '0.2rem', fontSize: '0.82rem', color: 'var(--fg)' }}>
                Quelle: {uploadResult.source_name}
              </div>
            </>
          )}
        </div>
      )}

      {showNew && (
        <div style={styles.form}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <h3 style={{ margin: 0, fontSize: '0.95rem', color: 'var(--muted-fg)' }}>Neue Quelle</h3>
            <HelpTip content="Lege hier eine Datei-Quelle oder eine echte systemd-journal Quelle an. Journald-Quellen lesen ueber journalctl direkt aus dem System-Journal statt aus /var/log/boot.log." ariaLabel="Neue Quelle erklaeren" />
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <div style={styles.field}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <label style={styles.label}>Name</label>
                <HelpTip content="Verstaendlicher Anzeigename fuer die Quelle. Dieser Name wird spaeter in Filtern, Reports und Drilldowns verwendet." ariaLabel="Quellname erklaeren" />
              </div>
              <input value={name} onChange={e => setName(e.target.value)} style={styles.input} placeholder="z.B. syslog" />
            </div>
            <div style={styles.field}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <label style={styles.label}>Typ</label>
                <HelpTip content="Pfadbasierte Quellen lesen Logdateien vom Dateisystem (z.B. file, syslog, filebeat, winlogbeat). Journald liest ueber journalctl direkt aus dem systemd-Journal des Hosts." ariaLabel="Quelltyp erklaeren" />
              </div>
              <select value={sourceType} onChange={e => setSourceType(e.target.value as SourceKind)} style={styles.input}>
                <option value="file">Datei</option>
                <option value="syslog">Syslog-Datei</option>
                <option value="docker">Docker-JSON-Log</option>
                <option value="filebeat">Filebeat-Log</option>
                <option value="winlogbeat">Winlogbeat-Log</option>
                <option value="elastic_agent">Elastic Agent-Log</option>
                <option value="journald">Journald</option>
              </select>
            </div>
          </div>
          {sourceType !== 'journald' ? (
            <>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <div style={{ ...styles.field, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <label style={styles.label}>Dateipfad</label>
                    <HelpTip content="Absoluter Pfad zur Logdatei auf dem Host. Mit aktivierter Regex-Option wird nur der Dateiname als Regex gematcht." ariaLabel="Dateipfad erklaeren" />
                  </div>
                  <input value={path} onChange={e => setPath(e.target.value)} style={styles.input} placeholder="/var/log/syslog oder /home/user/logs/lotus-client-[0-9]{4}-[0-9]{2}-[0-9]{2}\.log" />
                </div>
              </div>
              <label style={styles.inlineCheckbox}>
                <input type="checkbox" checked={pathRegex} onChange={e => setPathRegex(e.target.checked)} />
                Dateipfad als Regex behandeln (Dateiname)
              </label>
            </>
          ) : (
            <label style={styles.inlineCheckbox}>
              <input type="checkbox" checked={bootOnly} onChange={e => setBootOnly(e.target.checked)} />
              Nur aktuellen Boot aus dem systemd-Journal lesen
            </label>
          )}
          <div style={styles.formActions}>
            <button onClick={handleCreate} disabled={saving || !name || (sourceType !== 'journald' && !path)} style={styles.saveBtn}>
              {saving ? 'Speichere...' : 'Erstellen'}
            </button>
            {sourceType === 'file' && (
              <>
                <div style={styles.uploadDivider}>oder</div>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".log,.txt,.csv,text/*"
                  style={{ display: 'none' }}
                  onChange={async e => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    await handleUpload(file)
                  }}
                />
                <button onClick={() => fileRef.current?.click()} disabled={uploading} style={styles.uploadBtn}>
                  {uploading ? 'Importiere…' : '📂 Datei wählen & importieren'}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {isLoading ? (
        <div style={{ color: 'var(--muted-fg)', padding: '2rem' }}>Lade...</div>
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
                  <span style={{ ...styles.badge, background: src.enabled ? '#16a34a' : 'var(--border)' }}>
                    {src.enabled ? 'aktiv' : 'inaktiv'}
                  </span>
                  <span style={{ ...styles.badge, background: 'var(--accent-soft)', color: 'var(--accent-fg)' }}>
                    {src.type}
                  </span>
                  {Boolean(src.config?.path_regex) && (
                    <span style={{ ...styles.badge, background: '#5b21b6', color: '#ede9fe' }}>
                      regex
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <button
                    onClick={() => setTailSource(src)}
                    disabled={!isPathBasedSourceType(src.type)}
                    style={isPathBasedSourceType(src.type) ? styles.tailBtn : styles.tailBtnDisabled}
                    title={isPathBasedSourceType(src.type) ? 'Live-Tail oeffnen' : 'Live-Ansicht nur fuer pfadbasierte Quellen'}
                  >
                    Live-Ansicht
                  </button>
                  <button onClick={() => setEditSource(src)} style={styles.testBtn}>
                    Bearbeiten
                  </button>
                  <button onClick={() => handleTest(src.id)} style={styles.testBtn}>
                    Testen
                  </button>
                  {pendingDelete === src.id ? (
                    <>
                      <span style={{ fontSize: '0.82rem', color: 'var(--danger-fg)', alignSelf: 'center' }}>Wirklich löschen?</span>
                      <button onClick={() => handleDelete(src.id)} style={{ ...styles.deleteBtn, background: 'var(--danger-fg)', color: '#fff' }}>Ja</button>
                      <button onClick={() => setPendingDelete(null)} style={styles.testBtn}>Abbrechen</button>
                    </>
                  ) : (
                    <button onClick={() => setPendingDelete(src.id)} style={styles.deleteBtn}>Löschen</button>
                  )}
                </div>
              </div>
              <div style={styles.path}>{describeSource(src)}</div>
              <div style={styles.healthGrid}>
                <div style={{ ...styles.healthBadge, background: sourceHealthTone(sourceStatusById.get(src.id)).bg, color: sourceHealthTone(sourceStatusById.get(src.id)).fg }}>
                  {sourceHealthTone(sourceStatusById.get(src.id)).text}
                </div>
                <div style={styles.healthMetric}>Events/min: {sourceStatusById.get(src.id)?.events_per_min ?? 0}</div>
                <div style={styles.healthMetric}>Parse Errors: {sourceStatusById.get(src.id)?.parse_error_count ?? 0}</div>
                <div style={styles.healthMetric}>Last Seen: {formatSourceHealthAge(sourceStatusById.get(src.id)?.last_seen_at)}</div>
              </div>
              {testResults[src.id] && (
                <div style={{ marginTop: '0.5rem', fontSize: '0.82rem', color: testResults[src.id].ok ? 'var(--success-fg)' : 'var(--danger-fg)' }}>
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
  addBtn: { background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '0.5rem 1rem', cursor: 'pointer', fontWeight: 600 },
  liveHint: { background: 'var(--accent-soft)', color: 'var(--accent-fg)', border: '1px solid var(--accent)', borderRadius: 8, padding: '0.65rem 0.9rem', marginBottom: '1rem', fontSize: '0.86rem' },
  form: { background: 'var(--surface)', borderRadius: 10, padding: '1.25rem', border: '1px solid var(--border)', marginBottom: '1.5rem' },
  formActions: { display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.75rem' },
  field: { display: 'flex', flexDirection: 'column', gap: '0.3rem', flex: 1 },
  inlineCheckbox: { display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--muted-fg)', fontSize: '0.84rem', marginTop: '0.5rem', cursor: 'pointer' },
  label: { color: 'var(--muted-fg)', fontSize: '0.78rem' },
  input: { background: 'var(--surface-2)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.4rem 0.65rem', fontSize: '0.9rem' },
  saveBtn: { background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, padding: '0.5rem 1.25rem', cursor: 'pointer', fontWeight: 600 },
  uploadBtn: { background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '0.5rem 1.25rem', cursor: 'pointer', fontWeight: 600 },
  uploadDivider: { color: 'var(--muted-fg)', fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' },
  uploadInfo: { borderRadius: 8, padding: '0.75rem 0.95rem', marginBottom: '1rem', border: '1px solid var(--border)' },
  dismissBtn: { position: 'absolute', top: '0.4rem', right: '0.5rem', background: 'none', border: 'none', color: 'var(--muted-fg)', cursor: 'pointer', fontSize: '1rem' },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' },
  sectionTitle: { color: 'var(--muted-fg)', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' },
  list: { display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  card: { background: 'var(--surface)', borderRadius: 10, padding: '1rem 1.25rem', border: '1px solid var(--border)' },
  healthGrid: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.6rem' },
  healthBadge: { borderRadius: 999, padding: '0.15rem 0.55rem', fontSize: '0.72rem', fontWeight: 700 },
  healthMetric: { color: 'var(--muted-fg)', fontSize: '0.77rem' },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem', flexWrap: 'wrap', gap: '0.5rem' },
  srcName: { fontWeight: 600, fontSize: '0.95rem' },
  badge: { borderRadius: 4, padding: '0.12rem 0.5rem', fontSize: '0.72rem', fontWeight: 700, color: '#fff' },
  path: { fontSize: '0.82rem', color: 'var(--muted-fg)', fontFamily: 'monospace' },
  testBtn: { background: 'none', border: '1px solid var(--border)', color: 'var(--muted-fg)', borderRadius: 6, padding: '0.35rem 0.85rem', cursor: 'pointer', fontSize: '0.84rem' },
  tailBtn: { background: 'var(--accent-soft)', border: '1px solid var(--accent)', color: 'var(--accent-fg)', borderRadius: 6, padding: '0.35rem 0.9rem', cursor: 'pointer', fontSize: '0.84rem', fontWeight: 700 },
  tailBtnDisabled: { background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--muted-fg)', borderRadius: 6, padding: '0.35rem 0.9rem', cursor: 'not-allowed', fontSize: '0.84rem', fontWeight: 700 },
  deleteBtn: { background: 'none', border: '1px solid var(--danger-fg)', color: 'var(--danger-fg)', borderRadius: 6, padding: '0.35rem 0.85rem', cursor: 'pointer', fontSize: '0.84rem' },
  emptyState: { padding: '2rem', color: 'var(--muted-fg)', textAlign: 'center' },
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
