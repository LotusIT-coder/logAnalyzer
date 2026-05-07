import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import { AuthProvider } from '../ctx/AuthContext'
import RulesPage from '../pages/RulesPage'
import SourcesPage from '../pages/SourcesPage'
import IncidentsPage from '../pages/IncidentsPage'

vi.mock('../lib/requests', () => ({
  getRules: vi.fn(),
  createRule: vi.fn(),
  patchRule: vi.fn(),
  getSources: vi.fn(),
  createSource: vi.fn(),
  testSource: vi.fn(),
  patchSource: vi.fn(),
  deleteSource: vi.fn(),
  getIncidents: vi.fn(),
  patchIncident: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  getApiBase: vi.fn(() => '/api/v1'),
  getStoredToken: vi.fn(() => 'viewer-token'),
}))

vi.mock('../components/GlobalSourceFilterNotice', () => ({
  default: () => <div>global-filter</div>,
}))

import { getRules, getSources, getIncidents } from '../lib/requests'

const mockGetRules = vi.mocked(getRules)
const mockGetSources = vi.mocked(getSources)
const mockGetIncidents = vi.mocked(getIncidents)

function renderWithViewer(ui: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider
        value={{
          me: { subject: 'viewer@example.com', role: 'viewer', scopes: ['read'] },
          isLoading: false,
          login: vi.fn(),
          logout: vi.fn(),
        }}
      >
        {ui}
      </AuthProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetRules.mockResolvedValue({
    items: [
      { id: 'rule-1', name: 'Error burst', severity: 'error', threshold: 5, window_seconds: 300, enabled: true },
    ],
  } as any)
  mockGetSources.mockResolvedValue([
    { id: 'source-1', name: 'syslog', type: 'file', enabled: true, config: { path: '/var/log/syslog' } },
  ] as any)
  mockGetIncidents.mockResolvedValue({
    items: [
      {
        id: 'inc-1',
        title: 'SSH brute force',
        status: 'open',
        severity: 'critical',
        event_count: 12,
        first_seen: '2026-05-06T10:00:00Z',
        last_seen: '2026-05-06T10:05:00Z',
      },
    ],
  } as any)
})

describe('scope-based UI hardening', () => {
  test('shows rules page in read-only mode for viewers', async () => {
    renderWithViewer(<RulesPage />)

    expect(await screen.findByText('Error burst')).toBeInTheDocument()
    expect(screen.getByText('Regeln koennen mit diesem Token nur gelesen werden.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '+ Neue Regel' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Deakt.' })).not.toBeInTheDocument()
  })

  test('shows sources page in read-only mode for viewers', async () => {
    renderWithViewer(<SourcesPage />)

    expect(await screen.findByText('syslog')).toBeInTheDocument()
    expect(screen.getByText('Quellen koennen mit diesem Token nur gelesen und getestet werden.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '+ Neue Quelle' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Bearbeiten' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Löschen' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Testen' })).toBeInTheDocument()
  })

  test('shows incidents page in read-only mode for viewers', async () => {
    renderWithViewer(<IncidentsPage />)

    expect(await screen.findByText('SSH brute force')).toBeInTheDocument()
    expect(screen.getByText('Incidents koennen mit diesem Token nur gelesen werden.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /→/ })).not.toBeInTheDocument()
  })
})