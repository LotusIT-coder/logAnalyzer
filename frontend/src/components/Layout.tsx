import { NavLink, Outlet } from 'react-router-dom'
import { useFeatureFlags } from '../ctx/FeatureFlagsContext'
import HelpTip from './HelpTip'
import QuickTutorial from './QuickTutorial'

const NAV_BASE: { to: string; label: string; help: string }[] = [
  { to: '/', label: 'Dashboard', help: 'Zentrale Metriken, Quellenauswahl und Zeitraeume fuer den aktuellen Arbeitskontext.' },
  { to: '/events', label: 'Events', help: 'Detailansicht der Rohereignisse mit Filtern fuer Quelle, Host, Service, Schweregrad und Zeit.' },
  { to: '/incidents', label: 'Incidents', help: 'Gruppierte Auffaelligkeiten und bereits erkannte Stoerungen mit Status und Bearbeitungshinweisen.' },
  { to: '/rules', label: 'Regeln', help: 'Erkennungslogik fuer wiederkehrende Muster, Schwellwerte und automatische Incident-Erzeugung.' },
  { to: '/sources', label: 'Quellen', help: 'Verwaltung der angebundenen Logdateien und Datenquellen.' },
  { to: '/ai', label: 'AI Chat', help: 'Analyseassistent fuer Logs und Incidents.' },
]

export default function Layout() {
  const flags = useFeatureFlags()
  
  const navItems = NAV_BASE.filter(item => {
    if (item.to === '/ai') {
      return flags.ollama_available
    }
    return true
  })

  return (
    <div style={styles.root}>
      <aside style={styles.sidebar}>
        <div style={styles.logo}>Log<span style={{ color: '#3b82f6' }}>Analyzer</span></div>
        <nav style={styles.nav}>
          {navItems.map(n => (
            <div key={n.to} style={styles.navRow}>
              <NavLink
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
              <HelpTip content={n.help} ariaLabel={`${n.label} erklaeren`} />
            </div>
          ))}
        </nav>
      </aside>
      <main style={styles.main}>
        <div style={styles.mainToolbar}>
          <div style={styles.mainToolbarHint}>
            <span>i-Buttons erklaeren Bedienelemente direkt im Kontext.</span>
            <HelpTip content="Nutze die kleinen i-Schaltflaechen neben Bereichen, Filtern und Navigationseintraegen fuer kurze Erklaerungen." ariaLabel="Hinweis zu Hilfeschaltflaechen" />
          </div>
          <QuickTutorial />
        </div>
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
  navRow: { display: 'flex', alignItems: 'center', gap: '0.4rem' },
  link: {
    display: 'block', flex: 1, padding: '0.55rem 0.75rem', borderRadius: 6,
    textDecoration: 'none', fontWeight: 500, fontSize: '0.9rem',
    transition: 'background 0.15s',
  },
  main: { flex: 1, padding: '1.2rem 2rem 2rem 2rem', overflow: 'auto' },
  mainToolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '1rem',
    marginBottom: '1rem',
    flexWrap: 'wrap',
  },
  mainToolbarHint: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    color: '#94a3b8',
    fontSize: '0.82rem',
  },
}
