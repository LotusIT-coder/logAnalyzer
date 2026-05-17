import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'

import EventsPage from '../pages/EventsPage'

vi.mock('../lib/requests', () => ({
  getEvents: vi.fn(),
  getSources: vi.fn(),
}))

import { getEvents, getSources, type EventListResponse, type SourceResponse } from '../lib/requests'

const mockGetEvents = vi.mocked(getEvents)
const mockGetSources = vi.mocked(getSources)

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

beforeEach(() => {
  vi.clearAllMocks()
  mockGetSources.mockResolvedValue([{ id: 'source-123', name: 'Syslog', type: 'file', enabled: true, config: { path: '/var/log/syslog' } }] satisfies SourceResponse[])
  mockGetEvents.mockResolvedValue({ items: [], next_cursor: undefined } satisfies EventListResponse)
})

describe('EventsPage', () => {
  test('hydrates filters from URL params', async () => {
    renderPage('/events?host=app01&service=orders-api&q=db01&source_id=source-123&from=2026-05-05T12:00:00.000Z&to=2026-05-06T12:00:00.000Z')

    await waitFor(() => {
      expect(mockGetEvents).toHaveBeenCalledWith({
        limit: 50,
        cursor: undefined,
        from: '2026-05-05T12:00:00.000Z',
        to: '2026-05-06T12:00:00.000Z',
        source_id: 'source-123',
        severity: undefined,
        host: 'app01',
        service: 'orders-api',
        q: 'db01',
      })
    })

    expect(screen.getByDisplayValue('app01')).toBeInTheDocument()
    expect(screen.getByDisplayValue('orders-api')).toBeInTheDocument()
    expect(screen.getByDisplayValue('db01')).toBeInTheDocument()
    expect(screen.getByLabelText('Aktiver Kontext')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('Quelle: Syslog')).toBeInTheDocument()
    })
    expect(screen.getByText((content) => content.startsWith('Zeitraum: '))).toBeInTheDocument()
    expect(screen.getByText('Host: app01')).toBeInTheDocument()
    expect(screen.getByText('Service: orders-api')).toBeInTheDocument()
    expect(screen.getByText('Suche: db01')).toBeInTheDocument()
  })

  test('renders contextual help for filters and result context', async () => {
    renderPage('/events?host=app01&source_ids=source-123,source-456')

    expect(await screen.findByLabelText('Events erklaeren')).toBeInTheDocument()
    expect(screen.getByLabelText('Quellenfilter erklaeren')).toBeInTheDocument()
    expect(screen.getByLabelText('Severity-Filter erklaeren')).toBeInTheDocument()
    expect(screen.getByLabelText('Aktiven Kontext erklaeren')).toBeInTheDocument()
  })

  test('passes multi-source drilldown params through to the event query', async () => {
    renderPage('/events?host=app01&source_ids=source-123,source-456&source_paths=/var/log/app.log,/srv/custom.log')

    await waitFor(() => {
      expect(mockGetEvents).toHaveBeenCalledWith({
        limit: 50,
        cursor: undefined,
        from: undefined,
        to: undefined,
        source_id: undefined,
        source_ids: 'source-123,source-456',
        source_paths: '/var/log/app.log,/srv/custom.log',
        severity: undefined,
        host: 'app01',
        service: undefined,
        q: undefined,
      })
    })

    expect(screen.getByLabelText('Aktiver Kontext')).toBeInTheDocument()
    expect(screen.getByText('Quellen: 2')).toBeInTheDocument()
    expect(screen.getByText('Pfade: 2')).toBeInTheDocument()
    expect(screen.getByText('Host: app01')).toBeInTheDocument()
  })

  test('drops stale source paths that do not belong to the selected source id', async () => {
    renderPage('/events?source_ids=source-123&source_paths=/var/log/auth.log,/var/log/syslog')

    await waitFor(() => {
      expect(mockGetEvents).toHaveBeenLastCalledWith({
        limit: 50,
        cursor: undefined,
        from: undefined,
        to: undefined,
        source_id: undefined,
        source_ids: 'source-123',
        source_paths: '/var/log/syslog',
        severity: undefined,
        host: undefined,
        service: undefined,
        q: undefined,
      })
    })
  })

  test('passes provider query param through to the event request', async () => {
    renderPage('/events?provider=postgres&q=db01')

    await waitFor(() => {
      expect(mockGetEvents).toHaveBeenCalledWith({
        limit: 50,
        cursor: undefined,
        from: undefined,
        to: undefined,
        source_id: undefined,
        source_ids: undefined,
        source_paths: undefined,
        severity: undefined,
        provider: 'postgres',
        host: undefined,
        service: undefined,
        q: 'db01',
      })
    })

    expect(screen.getAllByText('Provider: postgres').length).toBeGreaterThan(0)
  })

  test('opens ANSI color legend modal via top-toolbar event', async () => {
    renderPage('/events')
    fireEvent(window, new Event('events:open-color-legend'))

    expect(screen.getByText('ANSI-Farben in Log-Nachrichten')).toBeInTheDocument()
    expect(screen.getByText('31 / 91')).toBeInTheDocument()
  })
})