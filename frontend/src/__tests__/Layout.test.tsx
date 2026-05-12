/**
 * Unit tests for the Layout navigation component.
 * Checks that all nav links render correctly and the logo is visible.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Layout from '../components/Layout'
import { FeatureFlagsContext } from '../ctx/FeatureFlagsContext.shared'

function renderLayout(initialPath = '/', ollamaAvailable = false) {
  return render(
    <FeatureFlagsContext.Provider value={{ ollama_available: ollamaAvailable }}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Layout />
      </MemoryRouter>
    </FeatureFlagsContext.Provider>
  )
}

describe('Layout', () => {
  test('renders logo', () => {
    const { container } = renderLayout()
    // Logo is split into "Log" + <span>Analyzer</span> — query by partial text
    expect(container.querySelector('aside')).toHaveTextContent('LogAnalyzer')
  })

  test('renders all navigation links', () => {
    renderLayout('/')
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Events' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Incidents' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Regeln' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Quellen' })).toBeInTheDocument()
  })

  test('renders AI Chat link when ollama is available', () => {
    renderLayout('/', true)
    expect(screen.getByRole('link', { name: 'AI Chat' })).toBeInTheDocument()
  })

  test('hides AI Chat link when ollama is unavailable', () => {
    renderLayout('/', false)
    expect(screen.queryByRole('link', { name: 'AI Chat' })).not.toBeInTheDocument()
  })

  test('Dashboard link points to /', () => {
    renderLayout()
    const link = screen.getByRole('link', { name: 'Dashboard' })
    expect(link).toHaveAttribute('href', '/')
  })

  test('Events link points to /events', () => {
    renderLayout()
    const link = screen.getByRole('link', { name: 'Events' })
    expect(link).toHaveAttribute('href', '/events')
  })

  test('AI Chat link points to /ai', () => {
    renderLayout('/', true)
    const link = screen.getByRole('link', { name: 'AI Chat' })
    expect(link).toHaveAttribute('href', '/ai')
  })

  test('active link has highlighted style on matching route', () => {
    renderLayout('/events')
    const eventsLink = screen.getByRole('link', { name: 'Events' })
    // React Router adds aria-current="page" to active NavLink
    expect(eventsLink).toHaveAttribute('aria-current', 'page')
  })

  test('non-active links do not have aria-current', () => {
    renderLayout('/events')
    const dashboardLink = screen.getByRole('link', { name: 'Dashboard' })
    expect(dashboardLink).not.toHaveAttribute('aria-current', 'page')
  })
})
