import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import SourcesPage from '../pages/SourcesPage'
import { AuthProvider } from '../ctx/AuthContext'

vi.mock('../lib/requests', () => ({
  getSources: vi.fn(),
  createSource: vi.fn(),
  testSource: vi.fn(),
  patchSource: vi.fn(),
  deleteSource: vi.fn(),
}))

import { getSources, type SourceResponse } from '../lib/requests'

const mockGetSources = vi.mocked(getSources)

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
        <SourcesPage />
      </AuthProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetSources.mockResolvedValue([
    { id: 'source-1', name: 'Syslog', type: 'file', enabled: true, config: { path: '/var/log/syslog' } },
  ] satisfies SourceResponse[])
})

describe('SourcesPage', () => {
  test('renders contextual help for source management and list actions', async () => {
    renderPage()

    expect(await screen.findByLabelText('Log-Quellen erklaeren')).toBeInTheDocument()
    expect(screen.getByLabelText('Live-Ansicht der Quellen erklaeren')).toBeInTheDocument()
    expect(await screen.findByText('Syslog')).toBeInTheDocument()
    expect(screen.getByLabelText('Quellenkarten erklaeren')).toBeInTheDocument()
  })
})