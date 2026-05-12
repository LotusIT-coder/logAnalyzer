import { useQuery } from '@tanstack/react-query'
import { analyzeUpload, getAIModels, uploadImport, type AIModelResponse } from '../lib/requests'
import { useRef, useState } from 'react'
import { getApiErrorMessage } from '../lib/errors'

interface AnalysisResult {
  lines_parsed: number
  events_found: number
  model: string
  analysis: string
}

interface ImportResult {
  source_id: string
  source_name: string
  stored_path: string
  lines_ingested: number
  events_created: number
}

export default function UploadPage() {
  const { data: models = [] } = useQuery({ queryKey: ['ai-models'], queryFn: getAIModels })

  const [model, setModel] = useState('')
  const [customPrompt, setCustomPrompt] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const effectiveModel = model || models[0]?.name || ''

  async function handleAnalyze() {
    if (!file) return
    setLoading(true)
    setResult(null)
    setImportResult(null)
    setError(null)
    try {
      const data = await analyzeUpload(file, effectiveModel, customPrompt.trim() || undefined)
      setResult(data)
    } catch (error: unknown) {
      setError(getApiErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }

  async function handleImport() {
    if (!file) return
    setLoading(true)
    setResult(null)
    setImportResult(null)
    setError(null)
    try {
      const data = await uploadImport(file, undefined)
      setImportResult(data)
    } catch (error: unknown) {
      setError(getApiErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.root}>
      <h2 style={styles.h2}>Log-Datei analysieren</h2>
      <p style={styles.sub}>
        Lade eine beliebige Log-Datei hoch – sie wird geparst und von Ollama analysiert.
        Bis zu 500 Zeilen werden ausgewertet (max. 10 MB).
      </p>

      <div style={styles.card}>
        <div style={styles.row}>
          <div style={styles.field}>
            <label style={styles.label}>Modell</label>
            <select
              value={model || effectiveModel}
              onChange={e => setModel(e.target.value)}
              style={styles.select}
            >
              {models.map((m: AIModelResponse) => (
                <option key={m.name} value={m.name}>{m.name}</option>
              ))}
            </select>
          </div>
          <div style={{ ...styles.field, flex: 1 }}>
            <label style={styles.label}>Log-Datei</label>
            <div style={styles.fileRow}>
              <input
                ref={fileRef}
                type="file"
                accept=".log,.txt,.csv,text/plain,application/octet-stream"
                style={{ display: 'none' }}
                onChange={e => setFile(e.target.files?.[0] ?? null)}
              />
              <button onClick={() => fileRef.current?.click()} style={styles.pickBtn}>
                Datei wählen…
              </button>
              <span style={styles.fileName}>
                {file ? `${file.name} (${(file.size / 1024).toFixed(1)} KB)` : 'Keine Datei gewählt'}
              </span>
            </div>
          </div>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>
            Eigener Prompt (optional – leer lassen für automatische Analyse)
          </label>
          <textarea
            value={customPrompt}
            onChange={e => setCustomPrompt(e.target.value)}
            placeholder={'z.B. "Welche Prozesse stürzen am häufigsten ab?"'}
            rows={3}
            style={styles.textarea}
          />
        </div>

        <div style={styles.actionRow}>
          <button
            onClick={handleAnalyze}
            disabled={!file || loading || !effectiveModel}
            style={styles.analyzeBtn}
          >
            {loading ? '⏳ Analysiere…' : '🔍 Analysieren'}
          </button>
          <button
            onClick={handleImport}
            disabled={!file || loading}
            style={styles.importBtn}
          >
            {loading ? '⏳ Importiere…' : 'In Quelle importieren'}
          </button>
        </div>
      </div>

      {error && (
        <div style={styles.errorBox}>{error}</div>
      )}

      {result && (
        <div style={styles.resultCard}>
          <div style={styles.resultMeta}>
            <span>📄 {result.lines_parsed} Zeilen geparst</span>
            <span>🧩 {result.events_found} strukturierte Events</span>
            <span>🤖 {result.model}</span>
          </div>
          <h3 style={styles.resultTitle}>Analyse</h3>
          <pre style={styles.resultText}>{result.analysis}</pre>
        </div>
      )}

      {importResult && (
        <div style={styles.resultCard}>
          <h3 style={styles.resultTitle}>Import abgeschlossen</h3>
          <div style={styles.resultMeta}>
            <span>Quelle: {importResult.source_name}</span>
            <span>{importResult.lines_ingested} Zeilen ingestiert</span>
            <span>{importResult.events_created} Events erstellt</span>
          </div>
          <div style={styles.fileName}>{importResult.stored_path}</div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { maxWidth: 900 },
  h2: { margin: '0 0 0.5rem 0', fontSize: '1.5rem' },
  sub: { color: 'var(--muted-fg)', fontSize: '0.88rem', marginBottom: '1.5rem' },
  readOnlyNotice: {
    background: 'var(--surface)', color: 'var(--fg)', borderRadius: 8,
    padding: '0.75rem 1rem', marginBottom: '1rem', border: '1px solid var(--border)', fontSize: '0.87rem',
  },
  card: {
    background: 'var(--surface)', borderRadius: 10, padding: '1.5rem',
    border: '1px solid var(--border)', marginBottom: '1.25rem',
    display: 'flex', flexDirection: 'column', gap: '1rem',
  },
  row: { display: 'flex', gap: '1rem', flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: '0.4rem' },
  label: { color: 'var(--muted-fg)', fontSize: '0.8rem' },
  select: {
    background: 'var(--surface-2)', color: 'var(--fg)', border: '1px solid var(--border)',
    borderRadius: 6, padding: '0.45rem 0.75rem', minWidth: 240,
  },
  fileRow: { display: 'flex', alignItems: 'center', gap: '0.75rem' },
  pickBtn: {
    background: 'var(--surface-2)', color: 'var(--fg)', border: '1px solid var(--border)',
    borderRadius: 6, padding: '0.45rem 1rem', cursor: 'pointer', flexShrink: 0,
  },
  fileName: { color: 'var(--muted-fg)', fontSize: '0.85rem' },
  textarea: {
    background: 'var(--surface-2)', color: 'var(--fg)', border: '1px solid var(--border)',
    borderRadius: 6, padding: '0.5rem 0.75rem', resize: 'vertical', fontSize: '0.88rem',
  },
  actionRow: { display: 'flex', gap: '0.75rem', flexWrap: 'wrap' },
  analyzeBtn: {
    background: 'var(--accent)', color: '#fff', border: 'none',
    borderRadius: 8, padding: '0.65rem 1.5rem', cursor: 'pointer',
    fontWeight: 700, fontSize: '0.95rem', alignSelf: 'flex-start',
  },
  importBtn: {
    background: '#16a34a', color: '#fff', border: 'none',
    borderRadius: 8, padding: '0.65rem 1.5rem', cursor: 'pointer',
    fontWeight: 700, fontSize: '0.95rem', alignSelf: 'flex-start',
  },
  errorBox: {
    background: 'color-mix(in srgb, var(--danger-fg) 16%, var(--surface))', color: 'var(--danger-fg)', borderRadius: 8,
    padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.87rem',
  },
  resultCard: {
    background: 'var(--surface)', borderRadius: 10, padding: '1.5rem',
    border: '1px solid var(--border)',
  },
  resultMeta: {
    display: 'flex', gap: '1.5rem', color: 'var(--muted-fg)', fontSize: '0.83rem',
    marginBottom: '1rem',
  },
  resultTitle: { margin: '0 0 0.75rem 0', color: 'var(--muted-fg)', fontSize: '0.95rem' },
  resultText: {
    margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    fontSize: '0.87rem', color: 'var(--fg)', lineHeight: 1.6,
  },
}
