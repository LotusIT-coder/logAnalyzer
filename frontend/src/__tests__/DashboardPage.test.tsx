import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

import DashboardPage from '../pages/DashboardPage'
import { I18nProvider } from '../ctx/I18nContext'
import { SourceFilterProvider } from '../ctx/SourceFilterContext'

vi.mock('../lib/requests', () => ({
  getTimeseries: vi.fn(),
  getTopErrors: vi.fn(),
  getTopServices: vi.fn(),
  getErrorRate: vi.fn(),
  getServerTime: vi.fn(),
  getMitreCoverage: vi.fn(),
  getSocAnalystStatus: vi.fn(),
  setSocAnalystStatus: vi.fn(),
  getSourceIngestionStatus: vi.fn(),
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
  getMitreCoverage,
  getServerTime,
  getSourceIngestionStatus,
  getSocAnalystStatus,
  getSources,
} from '../lib/requests'

const mockGetTimeseries = vi.mocked(getTimeseries)
const mockGetTopErrors = vi.mocked(getTopErrors)
const mockGetTopServices = vi.mocked(getTopServices)
const mockGetErrorRate = vi.mocked(getErrorRate)
const mockGetMitreCoverage = vi.mocked(getMitreCoverage)
const mockGetServerTime = vi.mocked(getServerTime)
const mockGetSourceIngestionStatus = vi.mocked(getSourceIngestionStatus)
const mockGetSocAnalystStatus = vi.mocked(getSocAnalystStatus)
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
      <I18nProvider>
        <SourceFilterProvider>
          <DashboardPage />
        </SourceFilterProvider>
      </I18nProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  window.localStorage.setItem('ui-language', 'de')
  mockGetSources.mockResolvedValue([] as SourceResponse[])
  mockGetTimeseries.mockResolvedValue({
    bucket: '1h',
    points: [{ ts: '2026-05-06T10:00:00Z', count: 5 }],
  } satisfies TimeseriesResponse)
  mockGetTopErrors.mockResolvedValue({
    items: [{ key: 'connection refused', count: 3, latest: '2026-05-06T10:00:00Z' }],
  } satisfies TopErrorsResponse)
  mockGetTopServices.mockResolvedValue({
    items: [{ service: 'nginx', count: 4 }],
  } satisfies TopServicesResponse)
  mockGetErrorRate.mockResolvedValue({
    total_events: 10,
    error_events: 3,
    error_rate: 0.3,
  } satisfies ErrorRateResponse)
  mockGetMitreCoverage.mockResolvedValue({
    items: [],
    mapped_rules: 0,
    mapped_incidents: 0,
  })
  mockGetServerTime.mockResolvedValue({ timestamp: '2026-05-06T10:00:00Z', unix_ms: 1778061600000 })
  mockGetSourceIngestionStatus.mockResolvedValue([])
  mockGetSocAnalystStatus.mockResolvedValue({
    enabled: false,
    running: false,
    source_ids: [],
    tick_count: 0,
  })
})

describe('DashboardPage', () => {
  test('uses manual global range for metrics requests', async () => {
    window.localStorage.setItem('logAnalyzer:globalSourceFilter', JSON.stringify({
      sourceIds: ['source-123'],
      sourcePaths: [],
      rangeHours: 24,
      severities: ['warning'],
      manualFrom: '2026-05-17T10:00:00.000Z',
      manualTo: '2026-05-17T11:00:00.000Z',
    }))
    window.localStorage.setItem('logAnalyzer:selectedSources', JSON.stringify([
      {
        id: 'source:source-123',
        label: 'Syslog',
        path: '/var/log/syslog',
        kind: 'configured',
      },
    ]))

    renderDashboard()

    await waitFor(() => {
      expect(mockGetErrorRate).toHaveBeenCalled()
      const [rangeArg] = mockGetErrorRate.mock.calls[0] ?? []
      expect(rangeArg).toMatchObject({
        from: '2026-05-17T10:00:00.000Z',
        to: '2026-05-17T11:00:00.000Z',
      })
    })
  })

  test('applies global severities to dashboard metrics queries', async () => {
    window.localStorage.setItem('logAnalyzer:globalSourceFilter', JSON.stringify({
      sourceIds: ['source-123'],
      sourcePaths: [],
      rangeHours: 24,
      severities: ['warning', 'error'],
      manualFrom: undefined,
      manualTo: undefined,
    }))
    window.localStorage.setItem('logAnalyzer:selectedSources', JSON.stringify([
      {
        id: 'source:source-123',
        label: 'Syslog',
        path: '/var/log/syslog',
        kind: 'configured',
      },
    ]))

    renderDashboard()

    await waitFor(() => {
      expect(mockGetTimeseries).toHaveBeenCalled()
      expect(mockGetErrorRate).toHaveBeenCalled()
    })

    const [timeseriesArg] = mockGetTimeseries.mock.calls[0] ?? []
    expect(timeseriesArg).toMatchObject({
      severity: 'warning,error',
    })

    const [, errorRateFilterArg] = mockGetErrorRate.mock.calls[0] ?? []
    expect(errorRateFilterArg).toMatchObject({
      severities: ['warning', 'error'],
    })
  })

  test('does not load metrics until a source is selected', async () => {
    renderDashboard()

    await waitFor(() => {
      expect(screen.getByText('Bitte eine oder mehrere Log-Quellen auswaehlen, um Metriken anzuzeigen.')).toBeInTheDocument()
    })

    expect(mockGetTimeseries).not.toHaveBeenCalled()
    expect(mockGetTopErrors).not.toHaveBeenCalled()
    expect(mockGetTopServices).not.toHaveBeenCalled()
    expect(mockGetErrorRate).not.toHaveBeenCalled()
  })

  test('does not load metrics when no severity is selected', async () => {
    window.localStorage.setItem('logAnalyzer:globalSourceFilter', JSON.stringify({
      sourceIds: ['source-123'],
      sourcePaths: [],
      rangeHours: 24,
      severities: [],
      manualFrom: undefined,
      manualTo: undefined,
    }))
    window.localStorage.setItem('logAnalyzer:selectedSources', JSON.stringify([
      {
        id: 'source:source-123',
        label: 'Syslog',
        path: '/var/log/syslog',
        kind: 'configured',
      },
    ]))

    renderDashboard()

    await waitFor(() => {
      expect(screen.getByText('Keine Severity ausgewaehlt. Bitte mindestens einen Schweregrad waehlen.')).toBeInTheDocument()
    })

    expect(mockGetTimeseries).not.toHaveBeenCalled()
    expect(mockGetTopErrors).not.toHaveBeenCalled()
    expect(mockGetTopServices).not.toHaveBeenCalled()
    expect(mockGetErrorRate).not.toHaveBeenCalled()
  })

  test('applies selected global severity from dropdown to graph and total requests', async () => {
    window.localStorage.setItem('logAnalyzer:globalSourceFilter', JSON.stringify({
      sourceIds: ['source-123'],
      sourcePaths: [],
      rangeHours: 24,
      severities: [],
      manualFrom: undefined,
      manualTo: undefined,
    }))
    window.localStorage.setItem('logAnalyzer:selectedSources', JSON.stringify([
      {
        id: 'source:source-123',
        label: 'Syslog',
        path: '/var/log/syslog',
        kind: 'configured',
      },
    ]))

    renderDashboard()

    const summary = await screen.findByText('Keine Schweregrade')
    fireEvent.click(summary)
    fireEvent.click(screen.getByLabelText(/warning/i))

    await waitFor(() => {
      expect(mockGetErrorRate).toHaveBeenCalled()
      expect(mockGetTimeseries).toHaveBeenCalled()
    })

    const [, errorRateFilterArg] = mockGetErrorRate.mock.calls.at(-1) ?? []
    expect(errorRateFilterArg).toMatchObject({ severities: ['warning'] })

    const [timeseriesArg] = mockGetTimeseries.mock.calls.at(-1) ?? []
    expect(timeseriesArg).toMatchObject({ severity: 'warning' })
  })

  test('renders contextual help for dashboard controls and summaries', async () => {
    renderDashboard()

    expect(await screen.findByLabelText('Dashboard erklaeren')).toBeInTheDocument()
    expect(screen.getByLabelText('Zeitfenster erklaeren')).toBeInTheDocument()
    expect(screen.getByLabelText('Quellenauswahl erklaeren')).toBeInTheDocument()
  })
})