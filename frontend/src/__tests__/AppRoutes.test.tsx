import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'

import { AppRoutes } from '../App'
import { AIChatProvider } from '../ctx/AIChatContext'
import { SourceFilterProvider } from '../ctx/SourceFilterContext'

vi.mock('../lib/requests', () => ({
  getErrorRate: vi.fn().mockResolvedValue({ total_events: 0, error_events: 0, error_rate: 0 }),
  getEventVolumeCheck: vi.fn().mockResolvedValue({ checked_events: 0, requires_confirmation: false, threshold: 5_000_000 }),
  getEvents: vi.fn().mockResolvedValue({ items: [], next_cursor: undefined }),
  getIncidents: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  getMitreCoverage: vi.fn().mockResolvedValue({ mapped_rules: 0, mapped_incidents: 0, techniques: [] }),
  getServerTime: vi.fn().mockResolvedValue({ timestamp: '2026-05-29T10:00:00.000Z', unix_ms: 1780048800000 }),
  getSocAnalystStatus: vi.fn().mockResolvedValue({ enabled: false, source_ids: [], source_paths: [], status: 'idle' }),
  getSourceIngestionStatus: vi.fn().mockResolvedValue([]),
  getSources: vi.fn().mockResolvedValue([]),
  getTimeseries: vi.fn().mockResolvedValue({ points: [] }),
  getTopErrors: vi.fn().mockResolvedValue({ items: [] }),
  getTopServices: vi.fn().mockResolvedValue({ items: [] }),
  resetMitreCoverage: vi.fn().mockResolvedValue({ archived_count: 0, archive_file: null, timestamp: '2026-05-29T10:00:00.000Z' }),
  runIngestion: vi.fn().mockResolvedValue({ results: [] }),
  setSocAnalystStatus: vi.fn().mockResolvedValue({ enabled: false, source_ids: [], source_paths: [], status: 'idle' }),
}))

function renderRoutes(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  render(
    <QueryClientProvider client={queryClient}>
      <SourceFilterProvider>
        <AIChatProvider>
          <MemoryRouter initialEntries={[initialPath]}>
            <AppRoutes />
          </MemoryRouter>
        </AIChatProvider>
      </SourceFilterProvider>
    </QueryClientProvider>
  )
}

describe('AppRoutes', () => {
  test('redirects unknown route to dashboard', async () => {
    renderRoutes('/does-not-exist')

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
  })
})