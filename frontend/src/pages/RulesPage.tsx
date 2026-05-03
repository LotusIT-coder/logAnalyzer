import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getRules, createRule, patchRule } from '../lib/requests'
import { useState } from 'react'

export default function RulesPage() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['rules'], queryFn: getRules })
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState({ name: '', severity: 'error', threshold: 5, window_seconds: 300, condition_field: 'severity', condition_value: 'error' })
  const [saving, setSaving] = useState(false)

  async function saveRule() {
    setSaving(true)
    try {
      await createRule({
        name: form.name,
        severity: form.severity,
        threshold: form.threshold,
        window_seconds: form.window_seconds,
        condition: { [form.condition_field]: form.condition_value },
        enabled: true,
      })
      qc.invalidateQueries({ queryKey: ['rules'] })
      setShowNew(false)
      setForm({ name: '', severity: 'error', threshold: 5, window_seconds: 300, condition_field: 'severity', condition_value: 'error' })
    } finally {
      setSaving(false)
    }
  }

  async function toggleRule(id: string, enabled: boolean) {
    await patchRule(id, { enabled: !enabled })
    qc.invalidateQueries({ queryKey: ['rules'] })
  }

  return (
    <div>
      <div style={styles.header}>
        <h2 style={styles.h2}>Regeln</h2>
        <button onClick={() => setShowNew(v => !v)} style={styles.addBtn}>
          {showNew ? '✕ Abbrechen' : '+ Neue Regel'}
        </button>
      </div>

      {showNew && (
        <div style={styles.form}>
          <h3 style={{ margin: '0 0 1rem 0', fontSize: '0.95rem', color: '#94a3b8' }}>Neue Regel</h3>
          <div style={styles.formGrid}>
            <Field label="Name">
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={styles.input} />
            </Field>
            <Field label="Severity">
              <select value={form.severity} onChange={e => setForm(f => ({ ...f, severity: e.target.value }))} style={styles.input}>
                {['info', 'warning', 'error', 'critical'].map(s => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Schwellenwert">
              <input type="number" min={1} value={form.threshold} onChange={e => setForm(f => ({ ...f, threshold: +e.target.value }))} style={styles.input} />
            </Field>
            <Field label="Zeitfenster (s)">
              <input type="number" min={1} value={form.window_seconds} onChange={e => setForm(f => ({ ...f, window_seconds: +e.target.value }))} style={styles.input} />
            </Field>
            <Field label="Condition Feld">
              <select value={form.condition_field} onChange={e => setForm(f => ({ ...f, condition_field: e.target.value }))} style={styles.input}>
                {['severity', 'service', 'host'].map(s => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Condition Wert">
              <input value={form.condition_value} onChange={e => setForm(f => ({ ...f, condition_value: e.target.value }))} style={styles.input} />
            </Field>
          </div>
          <button onClick={saveRule} disabled={saving || !form.name} style={styles.saveBtn}>
            {saving ? 'Speichere…' : 'Speichern'}
          </button>
        </div>
      )}

      {isLoading ? (
        <div style={{ color: '#64748b', padding: '2rem' }}>Lade…</div>
      ) : (
        <div style={styles.table}>
          <div style={styles.thead}>
            <span style={{ flex: 2 }}>Name</span>
            <span style={{ width: 80 }}>Severity</span>
            <span style={{ width: 80 }}>Schwelle</span>
            <span style={{ width: 100 }}>Zeitfenster</span>
            <span style={{ width: 80 }}>Status</span>
            <span style={{ width: 80 }}>Aktion</span>
          </div>
          {data?.items.map(r => (
            <div key={r.id} style={styles.row}>
              <span style={{ flex: 2, fontWeight: 500 }}>{r.name}</span>
              <span style={{ width: 80, color: '#f97316' }}>{r.severity}</span>
              <span style={{ width: 80, color: '#94a3b8' }}>{r.threshold}</span>
              <span style={{ width: 100, color: '#94a3b8' }}>{r.window_seconds}s</span>
              <span style={{ width: 80 }}>
                <span style={{ ...styles.pill, background: r.enabled ? '#16a34a' : '#475569' }}>
                  {r.enabled ? 'aktiv' : 'inaktiv'}
                </span>
              </span>
              <span style={{ width: 80 }}>
                <button onClick={() => toggleRule(r.id, r.enabled)} style={styles.toggleBtn}>
                  {r.enabled ? 'Deakt.' : 'Akt.'}
                </button>
              </span>
            </div>
          ))}
          {!data?.items.length && (
            <div style={{ padding: '2rem', color: '#64748b', textAlign: 'center' }}>Keine Regeln definiert</div>
          )}
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <label style={{ color: '#64748b', fontSize: '0.78rem' }}>{label}</label>
      {children}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' },
  h2: { margin: 0, fontSize: '1.5rem' },
  addBtn: { background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, padding: '0.5rem 1rem', cursor: 'pointer', fontWeight: 600 },
  form: { background: '#1e293b', borderRadius: 10, padding: '1.25rem', border: '1px solid #334155', marginBottom: '1.5rem' },
  formGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem', marginBottom: '1rem' },
  input: { background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '0.4rem 0.65rem', fontSize: '0.9rem' },
  saveBtn: { background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, padding: '0.5rem 1.25rem', cursor: 'pointer', fontWeight: 600 },
  table: { background: '#1e293b', borderRadius: 10, border: '1px solid #334155', overflow: 'hidden' },
  thead: { display: 'flex', gap: '1rem', padding: '0.6rem 1rem', background: '#0f172a', color: '#475569', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase' },
  row: { display: 'flex', gap: '1rem', padding: '0.6rem 1rem', borderTop: '1px solid #1e293b', alignItems: 'center', fontSize: '0.87rem' },
  pill: { borderRadius: 4, padding: '0.1rem 0.5rem', fontSize: '0.72rem', color: '#fff', fontWeight: 700 },
  toggleBtn: { background: 'none', border: '1px solid #334155', color: '#94a3b8', borderRadius: 5, padding: '0.2rem 0.55rem', cursor: 'pointer', fontSize: '0.78rem' },
}
