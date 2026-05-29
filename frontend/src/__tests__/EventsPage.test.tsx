import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'

import EventsPage from '../pages/EventsPage'
import { EMPTY_FILTER, SourceFilterContext } from '../ctx/SourceFilterContext.shared'

vi.mock('../lib/requests', () => ({
  getEvents: vi.fn(),
  getHealth: vi.fn(),
  getSourceIngestionStatus: vi.fn(),
  getSources: vi.fn(),
  getServerTime: vi.fn(),
}))

import { getEvents, getHealth, getServerTime, getSourceIngestionStatus, getSources, type EventListResponse, type SourceIngestionStatus, type SourceResponse } from '../lib/requests'

const mockGetEvents = vi.mocked(getEvents)
const mockGetHealth = vi.mocked(getHealth)
const mockGetSourceIngestionStatus = vi.mocked(getSourceIngestionStatus)
const mockGetSources = vi.mocked(getSources)
const mockGetServerTime = vi.mocked(getServerTime)

class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  onopen: ((ev: Event) => unknown) | null = null
  onmessage: ((ev: MessageEvent) => unknown) | null = null
  onerror: ((ev: Event) => unknown) | null = null
  close = vi.fn()

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
}

function renderPage(initialPath = '/events') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/events" element={<EventsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function renderPageWithFilter(initialPath: string, rangeHours: number) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <SourceFilterContext.Provider value={{
        filter: { ...EMPTY_FILTER, rangeHours },
        setFilter: vi.fn(),
        clearFilter: vi.fn(),
        hasFilter: false,
        selectedSources: [],
        setSelectedSources: vi.fn(),
        customSources: [],
        setCustomSources: vi.fn(),
      }}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/events" element={<EventsPage />} />
          </Routes>
        </MemoryRouter>
      </SourceFilterContext.Provider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  MockEventSource.instances = []
  vi.stubGlobal('EventSource', MockEventSource)
  mockGetSources.mockResolvedValue([{ id: 'source-123', name: 'Syslog', type: 'file', enabled: true, config: { path: '/var/log/syslog' } }] satisfies SourceResponse[])
  mockGetEvents.mockResolvedValue({ items: [], next_cursor: undefined } satisfies EventListResponse)
  mockGetHealth.mockResolvedValue({ status: 'ok', uptime_seconds: 12, timestamp: '2026-05-19T00:00:00.000Z', event_bus: { processed_total: 10, failed_total: 0, dead_letter_total: 0, dropped_queue_full_total: 0, queue_depth: 0 } })
  mockGetSourceIngestionStatus.mockResolvedValue([])
  mockGetServerTime.mockResolvedValue({ timestamp: '2026-05-19T00:00:00.000Z', unix_ms: 1716076800000 })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('EventsPage', () => {
  test('hydrates filters from URL params', async () => {
    renderPage('/events?host=app01&service=orders-api&q=db01&source_id=source-123&from=2026-05-05T12:00:00.000Z&to=2026-05-06T12:00:00.000Z')

    await waitFor(() => {
      expect(mockGetEvents).toHaveBeenCalledWith(expect.objectContaining({
        limit: 50,
        cursor: undefined,
        from: '2026-05-05T12:00:00.000Z',
        to: '2026-05-06T12:00:00.000Z',
        source_id: 'source-123',
        host: 'app01',
        service: 'orders-api',
        q: 'db01',
      }))
    })

    expect(screen.getByDisplayValue('app01')).toBeInTheDocument()
    expect(screen.getByDisplayValue('orders-api')).toBeInTheDocument()
    expect(screen.getByDisplayValue('db01')).toBeInTheDocument()
    expect(screen.getByLabelText('Aktiver Kontext')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText((content) => content.includes('Syslog'))).toBeInTheDocument()
    })
    expect(screen.getByText((content) => content.startsWith('Range: '))).toBeInTheDocument()
    expect(screen.getByText('Host: app01')).toBeInTheDocument()
    expect(screen.getByText('Service: orders-api')).toBeInTheDocument()
    expect(screen.getByText((content) => content.includes('db01'))).toBeInTheDocument()
  })

  test('renders contextual help for filters and result context', async () => {
    renderPage('/events?host=app01&source_ids=source-123,source-456')

    expect(await screen.findByLabelText('Explain events')).toBeInTheDocument()
    expect(screen.getByLabelText('Explain source filter')).toBeInTheDocument()
    expect(screen.getByLabelText('Explain severity filter')).toBeInTheDocument()
    expect(screen.getByLabelText('Explain active context')).toBeInTheDocument()
  })

  test('passes multi-source drilldown params through to the event query', async () => {
    renderPage('/events?host=app01&source_ids=source-123,source-456&source_paths=/var/log/app.log,/srv/custom.log')

    await waitFor(() => {
      expect(mockGetEvents).toHaveBeenCalled()
      const first = mockGetEvents.mock.calls[0]?.[0] as Record<string, unknown>
      expect(first.limit).toBe(50)
      expect(first.host).toBe('app01')
      if (typeof first.source_ids === 'string') {
        expect(first.source_ids).toContain('source-123')
      }
    })

    expect(screen.getByLabelText('Aktiver Kontext')).toBeInTheDocument()
    expect(screen.getByText('Sources: 2')).toBeInTheDocument()
    expect(screen.getByText('Host: app01')).toBeInTheDocument()
  })

  test('drops stale source paths that do not belong to the selected source id', async () => {
    renderPage('/events?source_ids=source-123&source_paths=/var/log/auth.log,/var/log/syslog')

    await waitFor(() => {
      const lastCall = mockGetEvents.mock.calls.at(-1)?.[0] as Record<string, unknown>
      expect(lastCall.limit).toBe(50)
      expect(lastCall.source_ids).toBe('source-123')
      if (typeof lastCall.source_paths === 'string') {
        expect(lastCall.source_paths).not.toContain('/var/log/auth.log')
      }
    })
  })

  test('passes provider query param through to the event request', async () => {
    renderPage('/events?source_id=source-123&provider=postgres&q=db01')

    await waitFor(() => {
      expect(mockGetEvents).toHaveBeenCalled()
      const hasProviderCall = mockGetEvents.mock.calls.some(([params]) => {
        const typed = params as Record<string, unknown>
        return typed.provider === 'postgres'
      })
      expect(hasProviderCall).toBe(true)
    })

    expect(screen.getAllByText('Provider: postgres').length).toBeGreaterThan(0)
  })

  test('uses wall-clock live window for presets', async () => {
    const expectedToMs = Date.parse('2026-05-29T07:13:50.000Z')
    const expectedFromMs = expectedToMs - 15 * 60_000
    mockGetServerTime.mockResolvedValueOnce({
      timestamp: '2026-05-29T07:13:50.000Z',
      unix_ms: Date.parse('2026-05-29T07:13:50.000Z'),
    })
    mockGetSourceIngestionStatus.mockResolvedValue([{ 
      source_id: 'source-123',
      last_ingested_at: '2026-05-29T07:11:07.881Z',
      last_event_timestamp: '2026-05-29T07:11:03.047Z',
      last_event_created_at: '2026-05-29T07:11:07.449Z',
      last_seen_at: '2026-05-29T07:11:07.449Z',
      events_per_min: 169,
      parse_error_count: 0,
    }] satisfies SourceIngestionStatus[])

    renderPageWithFilter('/events?source_id=source-123', 0.25)

    await waitFor(() => {
      const anchoredCall = mockGetEvents.mock.calls.find(([params]) => {
        const typed = params as Record<string, unknown>
        const fromMs = Date.parse(String(typed.from ?? ''))
        const toMs = Date.parse(String(typed.to ?? ''))
        return Number.isFinite(fromMs)
          && Number.isFinite(toMs)
          && Math.abs(toMs - expectedToMs) < 5_000
          && Math.abs(fromMs - expectedFromMs) < 5_000
      })
      expect(anchoredCall).toBeTruthy()
    })
  })

  test('maps degraded event bus health to degraded badge in header', async () => {
    mockGetHealth.mockResolvedValueOnce({
      status: 'ok',
      uptime_seconds: 99,
      timestamp: '2026-05-19T00:00:00.000Z',
      event_bus: {
        dead_letter_total: 2,
        dropped_queue_full_total: 1,
        failed_total: 5,
        queue_depth: 4,
      },
    })

    renderPage('/events?source_id=source-123')

    await waitFor(() => {
      expect(mockGetHealth).toHaveBeenCalled()
    })

    const degraded = await screen.findByText(/events\.health\.busDegraded|Event-Bus degradiert|event bus degraded/)
    expect(degraded).toBeInTheDocument()
    expect(degraded.getAttribute('title')).toContain('DLQ: 2')
    expect(degraded.getAttribute('title')).toContain('Drops: 1')
    expect(degraded.getAttribute('title')).toContain('Failed: 5')
  })

  test('maps missing event bus health to unavailable badge in header', async () => {
    mockGetHealth.mockResolvedValueOnce({
      status: 'ok',
      uptime_seconds: 101,
      timestamp: '2026-05-19T00:00:00.000Z',
      event_bus: null,
    })

    renderPage('/events?source_id=source-123')

    await waitFor(() => {
      expect(mockGetHealth).toHaveBeenCalled()
    })

    const unavailable = await screen.findByText(/events\.health\.busUnavailable|Event-Bus n\/v|event bus n\/a/)
    expect(unavailable).toBeInTheDocument()
  })

  test('maps non-ok system health to unknown badge in header', async () => {
    mockGetHealth.mockResolvedValueOnce({
      status: 'degraded',
      uptime_seconds: 101,
      timestamp: '2026-05-19T00:00:00.000Z',
      event_bus: {
        dead_letter_total: 0,
        dropped_queue_full_total: 0,
        failed_total: 0,
        queue_depth: 0,
      },
    })

    renderPage('/events?source_id=source-123')

    await waitFor(() => {
      expect(mockGetHealth).toHaveBeenCalled()
    })

    const unknown = await screen.findByText(/events\.health\.systemUnknown|System unbekannt|system unknown/)
    expect(unknown).toBeInTheDocument()
  })

})