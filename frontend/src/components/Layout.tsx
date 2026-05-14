import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useFeatureFlags } from '../ctx/FeatureFlagsContext'
import { useTheme } from '../ctx/ThemeContext'
import { useI18n } from '../ctx/I18nContext'
import HelpTip from './HelpTip'
import QuickTutorial from './QuickTutorial'

const NAV_BASE: { to: string; labelKey: string; help: string }[] = [
  { to: '/', labelKey: 'layout.nav.dashboard', help: 'Zentrale Metriken, Quellenauswahl und Zeitraeume fuer den aktuellen Arbeitskontext.' },
  { to: '/events', labelKey: 'layout.nav.events', help: 'Detailansicht der Rohereignisse mit Filtern fuer Quelle, Host, Service, Schweregrad und Zeit.' },
  { to: '/incidents', labelKey: 'layout.nav.incidents', help: 'Gruppierte Auffaelligkeiten und bereits erkannte Stoerungen mit Status und Bearbeitungshinweisen.' },
  { to: '/rules', labelKey: 'layout.nav.rules', help: 'Erkennungslogik fuer wiederkehrende Muster, Schwellwerte und automatische Incident-Erzeugung.' },
  { to: '/sources', labelKey: 'layout.nav.sources', help: 'Verwaltung der angebundenen Logdateien und Datenquellen.' },
  { to: '/ai', labelKey: 'layout.nav.ai', help: 'Analyseassistent fuer Logs und Incidents.' },
]

export default function Layout() {
  const flags = useFeatureFlags()
  const location = useLocation()
  const { theme, toggleTheme } = useTheme()
  const { language, setLanguage, t } = useI18n()
  const isEventsRoute = location.pathname === '/events'
  
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
                {t(n.labelKey)}
              </NavLink>
              <HelpTip content={n.help} ariaLabel={`${t(n.labelKey)} erklaeren`} />
            </div>
          ))}
        </nav>
      </aside>
      <main style={styles.main}>
        <div style={styles.mainToolbar}>
          <div style={styles.mainToolbarHint}>
            <span>{t('layout.hint.short')}</span>
            <HelpTip content={t('layout.hint.long')} ariaLabel="Hinweis zu Hilfeschaltflaechen" />
          </div>
          <div style={styles.toolbarActions}>
            <label style={styles.languageWrap}>
              <span style={styles.languageLabel}>{t('layout.lang.label')}</span>
              <select value={language} onChange={e => setLanguage(e.target.value as 'de' | 'en')} style={styles.languageSelect}>
                <option value="de">{t('lang.de')}</option>
                <option value="en">{t('lang.en')}</option>
              </select>
            </label>
            <button type="button" onClick={toggleTheme} style={styles.themeToggle}>
              {theme === 'dark' ? t('layout.theme.light') : t('layout.theme.dark')}
            </button>
            {isEventsRoute && (
              <button
                type="button"
                onClick={() => window.dispatchEvent(new Event('events:open-color-legend'))}
                style={styles.toolbarInfoBtn}
                title={t('layout.eventsLegend.tooltip')}
                aria-label={t('layout.eventsLegend.tooltip')}
              >
                {t('layout.eventsLegend.label')}
              </button>
            )}
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
  languageWrap: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.35rem',
  },
  languageLabel: {
    color: 'var(--muted-fg)',
    fontSize: '0.78rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  languageSelect: {
    background: 'var(--surface-2)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '0.4rem 0.5rem',
    fontSize: '0.8rem',
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
  toolbarInfoBtn: {
    background: 'var(--surface-2)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '0.45rem 0.7rem',
    cursor: 'pointer',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    fontSize: '0.82rem',
  },
}
