import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../ctx/AuthContext'

const NAV: { to: string; label: string }[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/events', label: 'Events' },
  { to: '/incidents', label: 'Incidents' },
  { to: '/rules', label: 'Regeln' },
  { to: '/sources', label: 'Quellen' },
  { to: '/ai', label: 'AI Chat' },
]

export default function Layout() {
  const { me } = useAuth()

  return (
    <div style={styles.root}>
      <aside style={styles.sidebar}>
        <div style={styles.logo}>Log<span style={{ color: '#3b82f6' }}>Analyzer</span></div>
        <nav style={styles.nav}>
          {NAV.map(n => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              style={({ isActive }) => ({
                ...styles.link,
                background: isActive ? '#1e3a5f' : 'transparent',
                color: isActive ? '#93c5fd' : '#94a3b8',
              })}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        {me?.subject && (
          <div style={styles.footer}>
            <span style={{ color: '#64748b', fontSize: '0.75rem' }}>{me.subject}</span>
          </div>
        )}
      </aside>
      <main style={styles.main}>
        <Outlet />
      </main>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', minHeight: '100vh', background: '#0f172a', color: '#f1f5f9' },
  sidebar: {
    width: 220, background: '#1e293b', display: 'flex', flexDirection: 'column',
    padding: '1.5rem 1rem', gap: '0.25rem', flexShrink: 0,
    borderRight: '1px solid #334155',
  },
  logo: {
    fontSize: '1.3rem', fontWeight: 700, color: '#f1f5f9',
    marginBottom: '2rem', paddingLeft: '0.5rem',
  },
  nav: { display: 'flex', flexDirection: 'column', gap: '0.15rem', flex: 1 },
  link: {
    display: 'block', padding: '0.55rem 0.75rem', borderRadius: 6,
    textDecoration: 'none', fontWeight: 500, fontSize: '0.9rem',
    transition: 'background 0.15s',
  },
  footer: {
    display: 'flex', flexDirection: 'column', gap: '0.4rem',
    borderTop: '1px solid #334155', paddingTop: '1rem', marginTop: 'auto',
  },
  logoutBtn: {
    background: 'none', border: '1px solid #334155', color: '#94a3b8',
    borderRadius: 6, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem',
  },
  main: { flex: 1, padding: '2rem', overflow: 'auto' },
}
