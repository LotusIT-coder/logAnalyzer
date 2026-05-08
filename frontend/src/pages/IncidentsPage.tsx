import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getIncidents, patchIncident } from '../lib/requests'
import dayjs from 'dayjs'
import { useState } from 'react'
import HelpTip from '../components/HelpTip'
import { hasScope } from '../ctx/authScopes'
import { useAuth } from '../ctx/useAuth'

const STATUS_COLOR: Record<string, string> = {
  open: '#ef4444',
  investigating: '#f97316',
  resolved: '#22c55e',
  false_positive: '#64748b',
}

const STATUSES = ['open', 'investigating', 'resolved', 'false_positive']

export default function IncidentsPage() {
  const qc = useQueryClient()
  const { me } = useAuth()
  const canWrite = hasScope(me, 'write')
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const { data, isLoading } = useQuery({
    queryKey: ['incidents', statusFilter],
    queryFn: () => getIncidents(statusFilter ? { status: statusFilter } : {}),
  })

  async function changeStatus(id: string, status: string) {
    await patchIncident(id, { status })
    qc.invalidateQueries({ queryKey: ['incidents'] })
  }

  // Client-side: newest first + title search
  const items = [...(data?.items ?? [])]
    .sort((a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime())
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
          <HelpTip content="Filtert die Incident-Liste nach Bearbeitungsstatus, zum Beispiel nur offene oder bereits geloeste Vorfaelle." ariaLabel="Statusfilter erklaeren" />
        </div>
      </div>

      {!canWrite && <div style={styles.readOnlyNotice}>Incidents koennen mit diesem Token nur gelesen werden.</div>}

      {isLoading ? (
        <div style={{ color: '#64748b', padding: '2rem' }}>Lade…</div>
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
                {canWrite && (
                  <div style={styles.actions}>
                    {STATUSES.filter(s => s !== inc.status).map(s => (
                      <button key={s} onClick={() => changeStatus(inc.id, s)} style={styles.statusBtn}>
                        → {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {!items.length && (
              <div style={{ padding: '2rem', color: '#64748b', textAlign: 'center' }}>Keine Incidents</div>
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
  readOnlyNotice: { background: '#1f2937', color: '#cbd5e1', border: '1px solid #334155', borderRadius: 8, padding: '0.65rem 0.9rem', marginBottom: '1rem', fontSize: '0.86rem' },
  searchInput: { background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '0.4rem 0.75rem', minWidth: 200 },
  select: { background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '0.4rem 0.6rem' },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' },
  sectionTitle: { color: '#94a3b8', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' },
  list: { display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  card: { background: '#1e293b', borderRadius: 10, padding: '1rem 1.25rem', border: '1px solid #334155' },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' },
  title: { fontWeight: 600, fontSize: '0.95rem' },
  badge: { borderRadius: 4, padding: '0.15rem 0.6rem', fontSize: '0.75rem', fontWeight: 700, color: '#fff' },
  meta: { display: 'flex', gap: '1.5rem', fontSize: '0.82rem', color: '#94a3b8', marginBottom: '0.75rem' },
  actions: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' },
  statusBtn: {
    background: 'none', border: '1px solid #334155', color: '#94a3b8',
    borderRadius: 6, padding: '0.25rem 0.65rem', cursor: 'pointer', fontSize: '0.78rem',
  },
}
