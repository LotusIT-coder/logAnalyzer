import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import SourcesPage from '../pages/SourcesPage'
import { I18nProvider } from '../ctx/I18nContext'

vi.mock('../lib/requests', () => ({
  getSources: vi.fn(),
  getSourceIngestionStatus: vi.fn(),
  createSource: vi.fn(),
  testSource: vi.fn(),
  patchSource: vi.fn(),
  deleteSource: vi.fn(),
}))

import { getSources, getSourceIngestionStatus, type SourceResponse } from '../lib/requests'

const mockGetSources = vi.mocked(getSources)
const mockGetSourceIngestionStatus = vi.mocked(getSourceIngestionStatus)

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <SourcesPage />
      </I18nProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.setItem('ui-language', 'de')
  mockGetSources.mockResolvedValue([
    { id: 'source-1', name: 'Syslog', type: 'file', enabled: true, config: { path: '/var/log/syslog' } },
  ] satisfies SourceResponse[])
  mockGetSourceIngestionStatus.mockResolvedValue([])
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