import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getRules, createRule, patchRule, deleteRule, type RuleResponse } from '../lib/requests'
import { useState } from 'react'
import GlobalSourceFilterNotice from '../components/GlobalSourceFilterNotice'
import HelpTip from '../components/HelpTip'

function EditRuleModal({
  rule,
  onClose,
  onSaved,
}: {
  rule: RuleResponse
  onClose: () => void
  onSaved: () => void
}) {
  const condition = (rule.condition ?? {}) as Record<string, unknown>
  const conditionEntry = Object.entries(condition).find(([k]) => ['severity', 'service', 'host'].includes(k))
  const [form, setForm] = useState({
    name: rule.name,
    severity: rule.severity,
    threshold: rule.threshold,
    window_seconds: rule.window_seconds,
    condition_field: conditionEntry?.[0] ?? 'severity',
    condition_value: String(conditionEntry?.[1] ?? ''),
  })
  const [saving, setSaving] = useState(false)

  async function saveRule() {
    setSaving(true)
    try {
      await patchRule(rule.id, {
        name: form.name,
        severity: form.severity,
        threshold: form.threshold,
        window_seconds: form.window_seconds,
        condition: { [form.condition_field]: form.condition_value },
      })
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={modal.overlay} onClick={onClose}>
      <div style={modal.box} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 1rem 0', fontSize: '1rem', color: 'var(--fg)' }}>Regel bearbeiten</h3>
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
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          <button onClick={saveRule} disabled={saving || !form.name} style={styles.saveBtn}>
            {saving ? 'Speichere…' : 'Speichern'}
          </button>
          <button onClick={onClose} style={styles.toggleBtn}>Abbrechen</button>
        </div>
      </div>
    </div>
  )
}

export default function RulesPage() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['rules'], queryFn: getRules })
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState({ name: '', severity: 'error', threshold: 5, window_seconds: 300, condition_field: 'severity', condition_value: 'error' })
  const [saving, setSaving] = useState(false)
  const [editRule, setEditRule] = useState<RuleResponse | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

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

  async function handleDelete(ruleId: string) {
    await deleteRule(ruleId)
    setPendingDelete(null)
    qc.invalidateQueries({ queryKey: ['rules'] })
  }

  return (
    <div>
      {editRule && (
        <EditRuleModal
          rule={editRule}
          onClose={() => setEditRule(null)}
          onSaved={() => qc.invalidateQueries({ queryKey: ['rules'] })}
        />
      )}
      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <h2 style={styles.h2}>Regeln</h2>
          <HelpTip content="Regeln erkennen wiederkehrende Muster in Events. Wenn die Bedingung im definierten Zeitfenster oft genug zutrifft, kann daraus ein Incident entstehen." ariaLabel="Regeln erklaeren" />
        </div>
        <button onClick={() => setShowNew(v => !v)} style={styles.addBtn}>
          {showNew ? '✕ Abbrechen' : '+ Neue Regel'}
        </button>
      </div>

      <GlobalSourceFilterNotice />

      {showNew && (
        <div style={styles.form}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <h3 style={{ margin: 0, fontSize: '0.95rem', color: 'var(--muted-fg)' }}>Neue Regel</h3>
            <HelpTip content="Definiere hier Name, Severity, Schwellwert und Bedingung fuer eine neue Erkennungsregel. Die Kombination steuert, wann aus Events ein Incident wird." ariaLabel="Neue Regel erklaeren" />
          </div>
          <div style={styles.formGrid}>
            <Field label="Name" help="Eindeutiger Anzeigename fuer die Regel. Er erscheint spaeter in Incident-Listen und Auswertungen.">
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={styles.input} />
            </Field>
            <Field label="Severity" help="Legt fest, mit welcher Dringlichkeit ein ausgeloester Incident markiert wird.">
              <select value={form.severity} onChange={e => setForm(f => ({ ...f, severity: e.target.value }))} style={styles.input}>
                {['info', 'warning', 'error', 'critical'].map(s => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Schwellenwert" help="Anzahl passender Events, die innerhalb des Zeitfensters auftreten muessen, bevor die Regel ausloest.">
              <input type="number" min={1} value={form.threshold} onChange={e => setForm(f => ({ ...f, threshold: +e.target.value }))} style={styles.input} />
            </Field>
            <Field label="Zeitfenster (s)" help="Zeitspanne in Sekunden, in der passende Events fuer den Schwellwert zusammengezaehlt werden.">
              <input type="number" min={1} value={form.window_seconds} onChange={e => setForm(f => ({ ...f, window_seconds: +e.target.value }))} style={styles.input} />
            </Field>
            <Field label="Condition Feld" help="Das Event-Feld, das fuer die Bedingung herangezogen wird, zum Beispiel Severity, Service oder Host.">
              <select value={form.condition_field} onChange={e => setForm(f => ({ ...f, condition_field: e.target.value }))} style={styles.input}>
                {['severity', 'service', 'host'].map(s => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Condition Wert" help="Der konkrete Wert, auf den das ausgewaehlte Feld geprueft wird. Beispiel: severity=error oder service=nginx.">
              <input value={form.condition_value} onChange={e => setForm(f => ({ ...f, condition_value: e.target.value }))} style={styles.input} />
            </Field>
          </div>
          <button onClick={saveRule} disabled={saving || !form.name} style={styles.saveBtn}>
            {saving ? 'Speichere…' : 'Speichern'}
          </button>
        </div>
      )}

      {isLoading ? (
        <div style={{ color: 'var(--muted-fg)', padding: '2rem' }}>Lade…</div>
      ) : (
        <>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>Aktive Regelbasis</span>
            <HelpTip content="Die Tabelle zeigt, welche Regeln aktiv sind und mit welchem Schwellwert sie arbeiten. Ueber die Aktion schaltest du Regeln schnell an oder aus, ohne sie neu anzulegen." ariaLabel="Regelliste erklaeren" />
          </div>
          <div style={styles.table}>
            <div style={styles.thead}>
              <span style={{ flex: 2 }}>Name</span>
              <span style={{ width: 80 }}>Severity</span>
              <span style={{ width: 80 }}>Schwelle</span>
              <span style={{ width: 100 }}>Zeitfenster</span>
              <span style={{ width: 80 }}>Status</span>
              <span style={{ width: 220 }}>Aktion</span>
            </div>
            {data?.items.map(r => (
              <div key={r.id} style={styles.row}>
                <span style={{ flex: 2, fontWeight: 500 }}>{r.name}</span>
                <span style={{ width: 80, color: '#f97316' }}>{r.severity}</span>
                <span style={{ width: 80, color: 'var(--muted-fg)' }}>{r.threshold}</span>
                <span style={{ width: 100, color: 'var(--muted-fg)' }}>{r.window_seconds}s</span>
                <span style={{ width: 80 }}>
                  <span style={{ ...styles.pill, background: r.enabled ? '#16a34a' : 'var(--border)' }}>
                    {r.enabled ? 'aktiv' : 'inaktiv'}
                  </span>
                </span>
                <span style={{ width: 220, display: 'flex', gap: '0.4rem' }}>
                  <button onClick={() => toggleRule(r.id, r.enabled)} style={styles.toggleBtn}>
                    {r.enabled ? 'Deakt.' : 'Akt.'}
                  </button>
                  <button onClick={() => setEditRule(r)} style={styles.toggleBtn}>Bearbeiten</button>
                  {pendingDelete === r.id ? (
                    <>
                      <button onClick={() => handleDelete(r.id)} style={styles.deleteBtn}>Ja, löschen</button>
                      <button onClick={() => setPendingDelete(null)} style={styles.toggleBtn}>Abbrechen</button>
                    </>
                  ) : (
                    <button onClick={() => setPendingDelete(r.id)} style={styles.deleteBtn}>Löschen</button>
                  )}
                </span>
              </div>
            ))}
            {!data?.items.length && (
              <div style={{ padding: '2rem', color: 'var(--muted-fg)', textAlign: 'center' }}>Keine Regeln definiert</div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
        <label style={{ color: 'var(--muted-fg)', fontSize: '0.78rem' }}>{label}</label>
        {help && <HelpTip content={help} ariaLabel={`${label} erklaeren`} />}
      </div>
      {children}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' },
  h2: { margin: 0, fontSize: '1.5rem' },
  addBtn: { background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '0.5rem 1rem', cursor: 'pointer', fontWeight: 600 },
  readOnlyNotice: { background: 'var(--accent-soft)', color: 'var(--accent-fg)', border: '1px solid var(--accent)', borderRadius: 8, padding: '0.65rem 0.9rem', marginBottom: '1rem', fontSize: '0.86rem' },
  form: { background: 'var(--surface)', borderRadius: 10, padding: '1.25rem', border: '1px solid var(--border)', marginBottom: '1.5rem' },
  formGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem', marginBottom: '1rem' },
  input: { background: 'var(--surface-2)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.4rem 0.65rem', fontSize: '0.9rem' },
  saveBtn: { background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, padding: '0.5rem 1.25rem', cursor: 'pointer', fontWeight: 600 },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' },
  sectionTitle: { color: 'var(--muted-fg)', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' },
  table: { background: 'var(--surface)', borderRadius: 10, border: '1px solid var(--border)', overflow: 'hidden' },
  thead: { display: 'flex', gap: '1rem', padding: '0.6rem 1rem', background: 'var(--table-head-bg)', color: 'var(--muted-fg)', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase' },
  row: { display: 'flex', gap: '1rem', padding: '0.6rem 1rem', borderTop: '1px solid var(--border)', alignItems: 'center', fontSize: '0.87rem' },
  pill: { borderRadius: 4, padding: '0.1rem 0.5rem', fontSize: '0.72rem', color: '#fff', fontWeight: 700 },
  toggleBtn: { background: 'none', border: '1px solid var(--border)', color: 'var(--muted-fg)', borderRadius: 5, padding: '0.2rem 0.55rem', cursor: 'pointer', fontSize: '0.78rem' },
  deleteBtn: { background: 'none', border: '1px solid var(--danger-fg)', color: 'var(--danger-fg)', borderRadius: 5, padding: '0.2rem 0.55rem', cursor: 'pointer', fontSize: '0.78rem' },
}

const modal: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  box: {
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
    width: '92vw', maxWidth: 900, padding: '1.25rem',
  },
}
