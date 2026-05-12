import { NavLink, Outlet } from 'react-router-dom'
import { useFeatureFlags } from '../ctx/FeatureFlagsContext'
import { useTheme } from '../ctx/ThemeContext'
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
  const { theme, toggleTheme } = useTheme()
  
  const navItems = NAV_BASE.filter(item => {
    if (item.to === '/ai') {
      return flags.ollama_available
    }
    return true
  })

  return (
    <div style={styles.root}>
      <aside style={styles.sidebar}>
        <div style={styles.logo}>Log<span style={{ color: 'var(--accent)' }}>Analyzer</span></div>
        <nav style={styles.nav}>
          {navItems.map(n => (
            <div key={n.to} style={styles.navRow}>
              <NavLink
                to={n.to}
                end={n.to === '/'}
                style={({ isActive }) => ({
                  ...styles.link,
                  background: isActive ? 'var(--nav-active-bg)' : 'transparent',
                  color: isActive ? 'var(--nav-active-fg)' : 'var(--muted-fg)',
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
          <div style={styles.toolbarActions}>
            <button type="button" onClick={toggleTheme} style={styles.themeToggle}>
              {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
            </button>
            <QuickTutorial />
          </div>
        </div>
        <Outlet />
      </main>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', minHeight: '100vh', background: 'var(--bg)', color: 'var(--fg)' },
  sidebar: {
    width: 220, background: 'var(--surface)', display: 'flex', flexDirection: 'column',
    padding: '1.5rem 1rem', gap: '0.25rem', flexShrink: 0,
    borderRight: '1px solid var(--border)',
  },
  logo: {
    fontSize: '1.3rem', fontWeight: 700, color: 'var(--fg)',
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
    color: 'var(--muted-fg)',
    fontSize: '0.82rem',
  },
  toolbarActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  themeToggle: {
    background: 'var(--surface-2)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '0.45rem 0.75rem',
    cursor: 'pointer',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
}
