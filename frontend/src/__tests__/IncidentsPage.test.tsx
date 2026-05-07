import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import IncidentsPage from '../pages/IncidentsPage'
import { AuthProvider } from '../ctx/AuthContext'

vi.mock('../lib/requests', () => ({
  getIncidents: vi.fn(),
  patchIncident: vi.fn(),
}))

import { getIncidents } from '../lib/requests'

const mockGetIncidents = vi.mocked(getIncidents)

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider
        value={{
          me: { subject: 'analyst@example.com', role: 'analyst', scopes: ['read', 'write'] },
          isLoading: false,
          login: vi.fn(),
          logout: vi.fn(),
        }}
      >
        <IncidentsPage />
      </AuthProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetIncidents.mockResolvedValue({
    items: [
      {
        id: 'inc-1',
        title: 'DNS saturation',
        status: 'open',
        severity: 'error',
        event_count: 4,
        first_seen: '2026-05-07T17:30:00.000Z',
        last_seen: '2026-05-07T17:35:00.000Z',
      },
    ],
  } as any)
})

describe('IncidentsPage', () => {
  test('renders contextual help for search, status filtering and incident overview', async () => {
    renderPage()

    expect(await screen.findByLabelText('Incidents erklaeren')).toBeInTheDocument()
    expect(screen.getByLabelText('Titelsuche erklaeren')).toBeInTheDocument()
    expect(screen.getByLabelText('Statusfilter erklaeren')).toBeInTheDocument()
    expect(await screen.findByText('DNS saturation')).toBeInTheDocument()
    expect(screen.getByLabelText('Incidentliste erklaeren')).toBeInTheDocument()
  })
})