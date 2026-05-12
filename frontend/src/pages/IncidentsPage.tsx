import { useQuery, useQueryClient } from '@tanstack/react-query'
import { archiveIncident, deleteIncident, getIncidents, patchIncident } from '../lib/requests'
import dayjs from 'dayjs'
import { useState } from 'react'
import HelpTip from '../components/HelpTip'
import GlobalSourceFilterNotice from '../components/GlobalSourceFilterNotice'
import { useSourceFilter } from '../ctx/useSourceFilter'

const STATUS_COLOR: Record<string, string> = {
  open: '#ef4444',
  investigating: '#f97316',
  resolved: '#22c55e',
  false_positive: '#64748b',
  archived: '#334155',
}

const STATUSES = ['open', 'investigating', 'resolved', 'false_positive', 'archived']
const ACTIVE_STATUSES = new Set(['open', 'investigating'])

export default function IncidentsPage() {
  const { filter: globalFilter } = useSourceFilter()
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const globalSourceIdsCsv = globalFilter.sourceIds.join(',')
  const globalSourcePathsCsv = globalFilter.sourcePaths.join(',')
  const { data, isLoading } = useQuery({
    queryKey: ['incidents', statusFilter, globalSourceIdsCsv, globalSourcePathsCsv],
    queryFn: () => getIncidents({
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(globalSourceIdsCsv ? { source_ids: globalSourceIdsCsv } : {}),
      ...(globalSourcePathsCsv ? { source_paths: globalSourcePathsCsv } : {}),
    }),
  })

  async function changeStatus(id: string, status: string) {
    await patchIncident(id, { status })
    qc.invalidateQueries({ queryKey: ['incidents'] })
  }

  async function archive(id: string) {
    await archiveIncident(id)
    qc.invalidateQueries({ queryKey: ['incidents'] })
  }

  async function remove(id: string) {
    setPendingDelete(null)
    await deleteIncident(id)
    qc.invalidateQueries({ queryKey: ['incidents'] })
  }

  // Client-side: newest first + title search
  const items = [...(data?.items ?? [])]
    .sort((a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime())
    .filter(inc => !activeOnly || ACTIVE_STATUSES.has(inc.status))
    .filter(inc => !search || inc.title.toLowerCase().includes(search.toLowerCase()))

  return (
    <div>
      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <h2 style={styles.h2}>Incidents</h2>
          <HelpTip content="Incidents fassen auffaellige oder problematische Ereignisse zusammen. Status, Severity und Zeitpunkte helfen bei Priorisierung und Bearbeitung." ariaLabel="Incidents erklaeren" />
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Titel suchen..."
            style={styles.searchInput}
          />
          <HelpTip content="Durchsucht die Incident-Titel clientseitig. Das ist hilfreich, wenn du bekannte Stoerungen oder Schlagwoerter schnell wiederfinden willst." ariaLabel="Titelsuche erklaeren" />
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={styles.select}>
            <option value="">Alle Status</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <button
            type="button"
            onClick={() => {
              setActiveOnly(v => !v)
              setStatusFilter('')
            }}
            style={{
              ...styles.quickFilterBtn,
              ...(activeOnly ? styles.quickFilterBtnActive : {}),
            }}
            aria-pressed={activeOnly}
          >
            Nur aktive
          </button>
          <HelpTip content="Filtert die Incident-Liste nach Bearbeitungsstatus, zum Beispiel nur offene oder bereits geloeste Vorfaelle." ariaLabel="Statusfilter erklaeren" />
        </div>
      </div>

      <GlobalSourceFilterNotice />

      {isLoading ? (
        <div style={{ color: 'var(--muted-fg)', padding: '2rem' }}>Lade…</div>
      ) : (
        <>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>Priorisierte Vorfaelle</span>
            <HelpTip content="Incidents werden nach dem letzten Auftreten sortiert. Die Status-Badges zeigen den Bearbeitungsstand, und die Statusaktionen verschieben einen Vorfall direkt in den naechsten Arbeitszustand." ariaLabel="Incidentliste erklaeren" />
          </div>
          <div style={styles.list}>
            {items.map(inc => (
              <div key={inc.id} style={styles.card}>
                <div style={styles.cardTop}>
                  <span style={styles.title}>{inc.title}</span>
                  <span style={{ ...styles.badge, background: STATUS_COLOR[inc.status] ?? '#475569' }}>
                    {inc.status}
                  </span>
                </div>
                <div style={styles.meta}>
                  <span>Severity: <b style={{ color: '#f97316' }}>{inc.severity}</b></span>
                  <span>Events: {inc.event_count}</span>
                  <span>Erstmalig: {dayjs(inc.first_seen).format('DD.MM.YYYY HH:mm')}</span>
                  <span>Zuletzt: {dayjs(inc.last_seen).format('DD.MM.YYYY HH:mm')}</span>
                </div>
                <div style={styles.actions}>
                  {inc.status !== 'archived' && (
                    <button onClick={() => archive(inc.id)} style={styles.archiveBtn}>
                      Archivieren
                    </button>
                  )}
                  {STATUSES.filter(s => s !== inc.status).map(s => (
                    <button key={s} onClick={() => changeStatus(inc.id, s)} style={styles.statusBtn}>
                      → {s}
                    </button>
                  ))}
                  {pendingDelete === inc.id ? (
                    <>
                      <span style={styles.deleteHint}>Wirklich löschen?</span>
                      <button onClick={() => remove(inc.id)} style={styles.deleteBtnConfirm}>Ja</button>
                      <button onClick={() => setPendingDelete(null)} style={styles.statusBtn}>Abbrechen</button>
                    </>
                  ) : (
                    <button onClick={() => setPendingDelete(inc.id)} style={styles.deleteBtn}>
                      Löschen
                    </button>
                  )}
                </div>
              </div>
            ))}
            {!items.length && (
              <div style={{ padding: '2rem', color: 'var(--muted-fg)', textAlign: 'center' }}>Keine Incidents</div>
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
  readOnlyNotice: { background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.65rem 0.9rem', marginBottom: '1rem', fontSize: '0.86rem' },
  searchInput: { background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.4rem 0.75rem', minWidth: 200 },
  select: { background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.4rem 0.6rem' },
  quickFilterBtn: {
    background: 'none',
    color: 'var(--muted-fg)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '0.4rem 0.75rem',
    cursor: 'pointer',
    fontSize: '0.82rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  quickFilterBtnActive: {
    background: 'var(--accent)',
    color: '#fff',
    borderColor: 'var(--accent)',
  },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' },
  sectionTitle: { color: 'var(--muted-fg)', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' },
  list: { display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  card: { background: 'var(--surface)', borderRadius: 10, padding: '1rem 1.25rem', border: '1px solid var(--border)' },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' },
  title: { fontWeight: 600, fontSize: '0.95rem' },
  badge: { borderRadius: 4, padding: '0.15rem 0.6rem', fontSize: '0.75rem', fontWeight: 700, color: '#fff' },
  meta: { display: 'flex', gap: '1.5rem', fontSize: '0.82rem', color: 'var(--muted-fg)', marginBottom: '0.75rem' },
  actions: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' },
  statusBtn: {
    background: 'none', border: '1px solid var(--border)', color: 'var(--muted-fg)',
    borderRadius: 6, padding: '0.25rem 0.65rem', cursor: 'pointer', fontSize: '0.78rem',
  },
  archiveBtn: {
    background: 'var(--accent-soft)', border: '1px solid var(--accent)', color: 'var(--accent-fg)',
    borderRadius: 6, padding: '0.25rem 0.65rem', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 700,
  },
  deleteBtn: {
    background: 'none', border: '1px solid var(--danger-fg)', color: 'var(--danger-fg)',
    borderRadius: 6, padding: '0.25rem 0.65rem', cursor: 'pointer', fontSize: '0.78rem',
  },
  deleteBtnConfirm: {
    background: 'var(--danger-fg)', border: '1px solid var(--danger-fg)', color: '#fff',
    borderRadius: 6, padding: '0.25rem 0.65rem', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 700,
  },
  deleteHint: { color: 'var(--danger-fg)', fontSize: '0.78rem', alignSelf: 'center' },
}
