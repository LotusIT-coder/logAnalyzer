import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

import DashboardPage from '../pages/DashboardPage'
import { SourceFilterProvider } from '../ctx/SourceFilterContext'

vi.mock('../lib/requests', () => ({
  getTimeseries: vi.fn(),
  getTopErrors: vi.fn(),
  getTopServices: vi.fn(),
  getErrorRate: vi.fn(),
  runIngestion: vi.fn(),
  getSources: vi.fn(),
  uploadImport: vi.fn(),
  deleteSource: vi.fn(),
}))

import {
  type ErrorRateResponse,
  type SourceResponse,
  type TimeseriesResponse,
  type TopErrorsResponse,
  type TopServicesResponse,
  getTimeseries,
  getTopErrors,
  getTopServices,
  getErrorRate,
  getSources,
} from '../lib/requests'

const mockGetTimeseries = vi.mocked(getTimeseries)
const mockGetTopErrors = vi.mocked(getTopErrors)
const mockGetTopServices = vi.mocked(getTopServices)
const mockGetErrorRate = vi.mocked(getErrorRate)
const mockGetSources = vi.mocked(getSources)

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <SourceFilterProvider>
        <DashboardPage />
      </SourceFilterProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetSources.mockResolvedValue([] as SourceResponse[])
  mockGetTimeseries.mockResolvedValue({
    bucket: '1h',
    points: [{ ts: '2026-05-06T10:00:00Z', count: 5 }],
  } satisfies TimeseriesResponse)
  mockGetTopErrors.mockResolvedValue({
    items: [{ key: 'connection refused', count: 3 }],
  } satisfies TopErrorsResponse)
  mockGetTopServices.mockResolvedValue({
    items: [{ service: 'nginx', count: 4 }],
  } satisfies TopServicesResponse)
  mockGetErrorRate.mockResolvedValue({
    total_events: 10,
    error_events: 3,
    error_rate: 0.3,
  } satisfies ErrorRateResponse)
})

describe('DashboardPage', () => {
  test('does not load metrics until a source is selected', async () => {
    renderDashboard()

    await waitFor(() => {
      expect(screen.getByText('Bitte eine oder mehrere Log-Quellen auswählen, um Metriken anzuzeigen.')).toBeInTheDocument()
    })

    expect(mockGetTimeseries).not.toHaveBeenCalled()
    expect(mockGetTopErrors).not.toHaveBeenCalled()
    expect(mockGetTopServices).not.toHaveBeenCalled()
    expect(mockGetErrorRate).not.toHaveBeenCalled()
  })

  test('renders contextual help for dashboard controls and summaries', async () => {
    renderDashboard()

    expect(await screen.findByLabelText('Dashboard erklaeren')).toBeInTheDocument()
    expect(screen.getByLabelText('Zeitfenster erklaeren')).toBeInTheDocument()
    expect(screen.getByLabelText('Quellenauswahl erklaeren')).toBeInTheDocument()
  })
})