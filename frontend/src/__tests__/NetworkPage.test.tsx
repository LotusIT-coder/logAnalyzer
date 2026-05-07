import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterAll, beforeAll, vi } from 'vitest'

import NetworkPage from '../pages/NetworkPage'
import { AuthProvider } from '../ctx/AuthContext'
import { SourceFilterProvider, useSourceFilter } from '../ctx/SourceFilterContext'

vi.mock('../lib/requests', () => ({
  getNetworkMap: vi.fn(),
}))

import { getNetworkMap } from '../lib/requests'

const mockGetNetworkMap = vi.mocked(getNetworkMap)
const eventSourceInstances: MockEventSource[] = []

class MockEventSource {
  url: string
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  close = vi.fn()

  constructor(url: string) {
    this.url = url
    eventSourceInstances.push(this)
  }

  emitOpen() {
    this.onopen?.(new Event('open'))
  }

  emitMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>)
  }
}

beforeAll(() => {
  vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource)
})

afterAll(() => {
  vi.unstubAllGlobals()
})

function SeedFilter({ sourceId, sourceIds, sourcePaths, rangeHours }: { sourceId?: string; sourceIds?: string[]; sourcePaths?: string[]; rangeHours?: number }) {
  const { setFilter } = useSourceFilter()

  useEffect(() => {
    if (!sourceId && !sourceIds?.length && !sourcePaths?.length && !rangeHours) return
    setFilter({ sourceIds: sourceId ? [sourceId] : (sourceIds ?? []), sourcePaths: sourcePaths ?? [], rangeHours: rangeHours ?? 0 })
  }, [])

  return null
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location-probe">{`${location.pathname}${location.search}`}</div>
}

function renderPage(options?: { sourceId?: string; sourceIds?: string[]; sourcePaths?: string[]; rangeHours?: number; initialPath?: string }) {
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
        <MemoryRouter initialEntries={[options?.initialPath ?? '/network']}>
          <SourceFilterProvider>
            <SeedFilter sourceId={options?.sourceId} sourceIds={options?.sourceIds} sourcePaths={options?.sourcePaths} rangeHours={options?.rangeHours} />
            <LocationProbe />
            <NetworkPage />
          </SourceFilterProvider>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  eventSourceInstances.length = 0
  mockGetNetworkMap.mockReset()
  mockGetNetworkMap.mockResolvedValue({
    nodes: [
      { id: 'app01', label: 'app01', kind: 'host', total_bytes: 2000, total_connections: 2, risk_score: 0 },
      { id: 'db01', label: 'db01', kind: 'host', total_bytes: 2000, total_connections: 2, risk_score: 0 },
    ],
    edges: [
      {
        source: 'app01',
        target: 'db01',
        app: 'orders-api',
        protocol: 'tcp',
        dst_port: 5432,
        bytes: 2000,
        connections: 2,
        allowed_count: 2,
        blocked_count: 0,
        anomaly_score: 0,
      },
    ],
  } as any)
})

describe('NetworkPage', () => {
  test('renders topology summary and graph details', async () => {
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Netzwerkfluesse' })).toBeInTheDocument()
    expect(await screen.findByText('2 Knoten')).toBeInTheDocument()
    expect(screen.getByText('1 Verbindung')).toBeInTheDocument()
    expect(screen.getAllByText('2.0 KB').length).toBeGreaterThan(0)
    expect(screen.getAllByText('app01').length).toBeGreaterThan(0)
    expect(screen.getAllByText('db01').length).toBeGreaterThan(0)
    expect(screen.getAllByText('orders-api').length).toBeGreaterThan(0)
    expect(screen.getByText('tcp / 5432')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Events zu app01' })).toHaveAttribute('href', '/events?host=app01')
    expect(screen.getByRole('link', { name: 'Events app01 nach db01' })).toHaveAttribute('href', '/events?host=app01&service=orders-api&q=db01')
    expect(screen.queryByText('Letzte Stunde')).not.toBeInTheDocument()
    expect(screen.queryByText('auth.log')).not.toBeInTheDocument()
  })

  test('opens KPI drilldowns for nodes, edges and volume', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /2 Knoten/i }))
    expect(screen.getByText('Aufschluesselung: Knoten')).toBeInTheDocument()
    expect(screen.getAllByText('2 Verbindungen').length).toBeGreaterThan(0)
    expect(screen.getAllByText('app01').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /1 Verbindung/i }))
    expect(screen.getByText('Aufschluesselung: Verbindungen')).toBeInTheDocument()
    expect(screen.getByText('orders-api / tcp / 5432')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /2.0 KB/i }))
    expect(screen.getByText('Aufschluesselung: Gesamtvolumen')).toBeInTheDocument()
    expect(screen.getByText('orders-api (tcp)')).toBeInTheDocument()
  })

  test('shows empty state when no graph data is available', async () => {
    mockGetNetworkMap.mockResolvedValueOnce({ nodes: [], edges: [] } as any)
    renderPage()

    expect(await screen.findByText('Keine Netzwerkfluesse im aktuellen Filter gefunden.')).toBeInTheDocument()
  })

  test('renders geolocation map details for public endpoints', async () => {
    mockGetNetworkMap.mockResolvedValueOnce({
      nodes: [
        { id: 'app01', label: 'app01', kind: 'host', total_bytes: 1200, total_connections: 1, risk_score: 0 },
        {
          id: 'google-dns',
          label: 'google-dns',
          kind: 'external',
          total_bytes: 1200,
          total_connections: 1,
          risk_score: 0,
          geo: {
            resolved_ip: '8.8.8.8',
            latitude: 37.386,
            longitude: -122.0838,
            city: 'Mountain View',
            region: 'California',
            country: 'United States',
            country_code: 'US',
            source: 'test',
          },
        },
      ],
      edges: [
        {
          source: 'app01',
          target: 'google-dns',
          app: 'dns',
          protocol: 'udp',
          dst_port: 53,
          bytes: 1200,
          connections: 1,
          allowed_count: 1,
          blocked_count: 0,
          anomaly_score: 0,
        },
      ],
    } as any)

    renderPage()

    expect(await screen.findByText('Geographische Flusskarte')).toBeInTheDocument()
    expect(screen.getByText('1 geolokalisierte Endpunkte')).toBeInTheDocument()
    expect(screen.getByText('Mountain View, California, United States')).toBeInTheDocument()
    expect(screen.getByText('8.8.8.8')).toBeInTheDocument()
  })

  test('tracks live traffic updates from the event stream', async () => {
    const recentIso = new Date(Date.now() - 1_000).toISOString()

    mockGetNetworkMap
      .mockResolvedValueOnce({ nodes: [], edges: [] } as any)
      .mockResolvedValueOnce({
        nodes: [
          { id: 'app01', label: 'app01', kind: 'host', total_bytes: 2048, total_connections: 1, risk_score: 0 },
          { id: '8.8.8.8', label: '8.8.8.8', kind: 'external', total_bytes: 2048, total_connections: 1, risk_score: 0 },
        ],
        edges: [
          {
            source: 'app01',
            target: '8.8.8.8',
            app: 'dns',
            protocol: 'udp',
            dst_port: 53,
            bytes: 2048,
            connections: 1,
            allowed_count: 1,
            blocked_count: 0,
            anomaly_score: 0,
          },
        ],
      } as any)

    renderPage()

    expect(await screen.findByText('Keine Netzwerkfluesse im aktuellen Filter gefunden.')).toBeInTheDocument()

    const stream = eventSourceInstances.at(-1)
    expect(stream?.url).toContain('/events/stream?event_type=network_flow&token=')

    await act(async () => {
      stream?.emitOpen()
    })
    await waitFor(() => {
      expect(screen.getByText(/Live verbunden/)).toBeInTheDocument()
    })

    await act(async () => {
      stream?.emitMessage({
        id: 'evt-1',
        timestamp: recentIso,
        created_at: recentIso,
        event_type: 'network_flow',
        host: 'app01',
        service: 'dns',
        message: 'dns flow observed',
        fields: {
          src_ip: 'app01',
          dst_ip: '8.8.8.8',
          protocol: 'udp',
          app: 'dns',
          bytes: 2048,
        },
      })
    })

    await screen.findByRole('link', { name: 'Events app01 nach 8.8.8.8' })

    expect(mockGetNetworkMap).toHaveBeenCalledTimes(1)

    expect(screen.getAllByText('1 Verbindung').length).toBeGreaterThan(0)
    expect(await screen.findByText('1 Updates / 60s')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB / 60s')).toBeInTheDocument()
    expect(screen.getAllByText('app01 → 8.8.8.8').length).toBeGreaterThan(0)
  })

  test('counts freshly streamed historical events by created_at', async () => {
    const recentCreatedAt = new Date(Date.now() - 1_000).toISOString()
    const oldEventTimestamp = new Date(Date.now() - 3 * 24 * 3600_000).toISOString()

    mockGetNetworkMap.mockResolvedValueOnce({ nodes: [], edges: [] } as any)

    renderPage()

    expect(await screen.findByText('Keine Netzwerkfluesse im aktuellen Filter gefunden.')).toBeInTheDocument()

    const stream = eventSourceInstances.at(-1)

    await act(async () => {
      stream?.emitOpen()
    })

    await act(async () => {
      stream?.emitMessage({
        id: 'evt-historical-live',
        timestamp: oldEventTimestamp,
        created_at: recentCreatedAt,
        event_type: 'network_flow',
        host: 'Rechenknecht',
        service: 'dns',
        message: 'historical event observed live',
        fields: {
          src_ip: 'livehost01',
          dst_ip: '1.1.1.1',
          protocol: 'udp',
          app: 'dns',
          bytes: 8192,
          dst_port: 53,
        },
      })
    })

    expect(await screen.findByText('1 Updates / 60s')).toBeInTheDocument()
    expect(screen.getByText('8.0 KB / 60s')).toBeInTheDocument()
    expect(screen.getAllByText('livehost01 → 1.1.1.1').length).toBeGreaterThan(0)
  })

  test('ignores single-source and range context in drilldown links', async () => {
    renderPage({ sourceId: 'source-123', rangeHours: 24 })

    const nodeLink = await screen.findByRole('link', { name: 'Events zu app01' })
    const edgeLink = await screen.findByRole('link', { name: 'Events app01 nach db01' })

    const nodeParams = new URLSearchParams(nodeLink.getAttribute('href')?.split('?')[1] ?? '')
    const edgeParams = new URLSearchParams(edgeLink.getAttribute('href')?.split('?')[1] ?? '')

    expect(nodeParams.get('host')).toBe('app01')
    expect(nodeParams.get('source_id')).toBeNull()
    expect(nodeParams.get('from')).toBeNull()
    expect(nodeParams.get('to')).toBeNull()

    expect(edgeParams.get('host')).toBe('app01')
    expect(edgeParams.get('service')).toBe('orders-api')
    expect(edgeParams.get('q')).toBe('db01')
    expect(edgeParams.get('source_id')).toBeNull()
    expect(edgeParams.get('from')).toBeNull()
    expect(edgeParams.get('to')).toBeNull()
  })

  test('ignores multi-source context in drilldown links', async () => {
    renderPage({ sourceIds: ['source-123', 'source-456'], sourcePaths: ['/var/log/app.log', '/srv/custom.log'] })

    const edgeLink = await screen.findByRole('link', { name: 'Events app01 nach db01' })
    const edgeParams = new URLSearchParams(edgeLink.getAttribute('href')?.split('?')[1] ?? '')

    expect(edgeParams.get('source_id')).toBeNull()
    expect(edgeParams.get('source_ids')).toBeNull()
    expect(edgeParams.get('source_paths')).toBeNull()
  })

  test('focuses a node and shows related connection context', async () => {
    renderPage()

    const nodeFocusButton = await screen.findByRole('button', { name: 'Knoten app01 fokussieren' })
    fireEvent.click(nodeFocusButton)

    expect(nodeFocusButton).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Fokus: app01')).toBeInTheDocument()
    expect(screen.getByText('1 verbundener Pfad')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB ueber diesen Knoten')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Events fuer Fokus' })).toHaveAttribute('href', '/events?host=app01')
    expect(screen.getByRole('button', { name: 'Fokus aufheben' })).toBeInTheDocument()
  })

  test('focuses a path and shows the selected connection details', async () => {
    renderPage()

    const edgeFocusButton = await screen.findByRole('button', { name: 'Pfad app01 nach db01 fokussieren' })
    fireEvent.click(edgeFocusButton)

    expect(edgeFocusButton).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Fokus: app01 → db01')).toBeInTheDocument()
    expect(screen.getByText('App: orders-api')).toBeInTheDocument()
    expect(screen.getByText('Protokoll: tcp / 5432')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB ueber diesen Pfad')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Events fuer Fokus' })).toHaveAttribute('href', '/events?host=app01&service=orders-api&q=db01')
  })

  test('limits the topology graph to the focused node neighborhood', async () => {
    mockGetNetworkMap.mockResolvedValueOnce({
      nodes: [
        { id: 'app01', label: 'app01', kind: 'host', total_bytes: 2000, total_connections: 2, risk_score: 0 },
        { id: 'db01', label: 'db01', kind: 'host', total_bytes: 2000, total_connections: 1, risk_score: 0 },
        { id: 'dns01', label: 'dns01', kind: 'host', total_bytes: 512, total_connections: 1, risk_score: 0 },
        { id: '8.8.8.8', label: '8.8.8.8', kind: 'external', total_bytes: 512, total_connections: 1, risk_score: 0 },
      ],
      edges: [
        {
          source: 'app01',
          target: 'db01',
          app: 'orders-api',
          protocol: 'tcp',
          dst_port: 5432,
          bytes: 2000,
          connections: 1,
          allowed_count: 1,
          blocked_count: 0,
          anomaly_score: 0,
        },
        {
          source: 'dns01',
          target: '8.8.8.8',
          app: 'dns',
          protocol: 'udp',
          dst_port: 53,
          bytes: 512,
          connections: 1,
          allowed_count: 1,
          blocked_count: 0,
          anomaly_score: 0,
        },
      ],
    } as any)

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Knoten app01 fokussieren' }))

    const topology = screen.getByRole('img', { name: 'Netzwerk Topologie' })
    expect(within(topology).getAllByText('app01').length).toBeGreaterThan(0)
    expect(within(topology).getAllByText('db01').length).toBeGreaterThan(0)
    expect(within(topology).queryAllByText('dns01')).toHaveLength(0)
    expect(within(topology).queryAllByText('8.8.8.8')).toHaveLength(0)
  })

  test('hydrates node focus from URL query params', async () => {
    renderPage({ initialPath: '/network?focus_node=app01' })

    expect(await screen.findByText('Fokus: app01')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Knoten app01 fokussieren' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('writes edge focus to the URL query params', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Pfad app01 nach db01 fokussieren' }))

    expect(screen.getByTestId('location-probe')).toHaveTextContent('/network?focus_edge=app01%7Cdb01%7Corders-api%7Ctcp%7C5432')
  })

  test('filters paths by app and protocol on the client', async () => {
    mockGetNetworkMap.mockResolvedValueOnce({
      nodes: [
        { id: 'app01', label: 'app01', kind: 'host', total_bytes: 2512, total_connections: 3, risk_score: 0 },
        { id: 'db01', label: 'db01', kind: 'host', total_bytes: 2000, total_connections: 2, risk_score: 0 },
        { id: 'dns01', label: 'dns01', kind: 'host', total_bytes: 512, total_connections: 1, risk_score: 0 },
      ],
      edges: [
        {
          source: 'app01',
          target: 'db01',
          app: 'orders-api',
          protocol: 'tcp',
          dst_port: 5432,
          bytes: 2000,
          connections: 2,
          allowed_count: 2,
          blocked_count: 0,
          anomaly_score: 0,
        },
        {
          source: 'app01',
          target: 'dns01',
          app: 'dns-forwarder',
          protocol: 'udp',
          dst_port: 53,
          bytes: 512,
          connections: 1,
          allowed_count: 1,
          blocked_count: 0,
          anomaly_score: 0,
        },
      ],
    } as any)

    renderPage()

    expect(await screen.findByText(/2\s+Verbindungen/, { selector: 'strong' })).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: 'Protokoll-Filter' }), { target: { value: 'udp' } })

    expect(screen.getByText(/1\s+Verbindung/, { selector: 'strong' })).toBeInTheDocument()
    expect(screen.queryByText('tcp / 5432')).not.toBeInTheDocument()
    expect(screen.getAllByText('dns-forwarder').length).toBeGreaterThan(0)
    expect(screen.queryByRole('link', { name: 'Events app01 nach db01' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Events app01 nach dns01' })).toHaveAttribute('href', '/events?host=app01&service=dns-forwarder&q=dns01')

    fireEvent.change(screen.getByRole('combobox', { name: 'App-Filter' }), { target: { value: 'dns-forwarder' } })
    expect(screen.getByText('2 Knoten')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Filter zuruecksetzen' }))
    expect(screen.getByText(/2\s+Verbindungen/, { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getAllByText('orders-api').length).toBeGreaterThan(0)
  })

  test('writes graph filters to the URL query params', async () => {
    mockGetNetworkMap.mockResolvedValueOnce({
      nodes: [
        { id: 'app01', label: 'app01', kind: 'host', total_bytes: 2512, total_connections: 3, risk_score: 0 },
        { id: 'db01', label: 'db01', kind: 'host', total_bytes: 2000, total_connections: 2, risk_score: 0 },
        { id: 'dns01', label: 'dns01', kind: 'host', total_bytes: 512, total_connections: 1, risk_score: 0 },
      ],
      edges: [
        {
          source: 'app01',
          target: 'db01',
          app: 'orders-api',
          protocol: 'tcp',
          dst_port: 5432,
          bytes: 2000,
          connections: 2,
          allowed_count: 2,
          blocked_count: 0,
          anomaly_score: 0,
        },
        {
          source: 'app01',
          target: 'dns01',
          app: 'dns-forwarder',
          protocol: 'udp',
          dst_port: 53,
          bytes: 512,
          connections: 1,
          allowed_count: 1,
          blocked_count: 0,
          anomaly_score: 0,
        },
      ],
    } as any)

    renderPage()

    expect(await screen.findByText(/2\s+Verbindungen/, { selector: 'strong' })).toBeInTheDocument()

    fireEvent.change(await screen.findByRole('combobox', { name: 'Protokoll-Filter' }), { target: { value: 'udp' } })
    await waitFor(() => {
      const params = new URLSearchParams(screen.getByTestId('location-probe').textContent?.split('?')[1] ?? '')
      expect(params.get('protocol')).toBe('udp')
    })

    fireEvent.change(screen.getByRole('combobox', { name: 'App-Filter' }), { target: { value: 'dns-forwarder' } })

    await waitFor(() => {
      const params = new URLSearchParams(screen.getByTestId('location-probe').textContent?.split('?')[1] ?? '')
      expect(params.get('protocol')).toBe('udp')
      expect(params.get('app')).toBe('dns-forwarder')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Filter zuruecksetzen' }))
    await waitFor(() => {
      expect(screen.getByTestId('location-probe')).toHaveTextContent('/network')
    })
  })

  test('writes the selected time window to the URL query params', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Zeitfenster 7 d' }))

    await waitFor(() => {
      const params = new URLSearchParams(screen.getByTestId('location-probe').textContent?.split('?')[1] ?? '')
      expect(params.get('window')).toBe('168')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Zeitfenster 24 h' }))

    await waitFor(() => {
      expect(screen.getByTestId('location-probe')).toHaveTextContent('/network')
    })
  })

  test('hydrates graph filters from URL query params', async () => {
    mockGetNetworkMap.mockResolvedValueOnce({
      nodes: [
        { id: 'app01', label: 'app01', kind: 'host', total_bytes: 2512, total_connections: 3, risk_score: 0 },
        { id: 'db01', label: 'db01', kind: 'host', total_bytes: 2000, total_connections: 2, risk_score: 0 },
        { id: 'dns01', label: 'dns01', kind: 'host', total_bytes: 512, total_connections: 1, risk_score: 0 },
      ],
      edges: [
        {
          source: 'app01',
          target: 'db01',
          app: 'orders-api',
          protocol: 'tcp',
          dst_port: 5432,
          bytes: 2000,
          connections: 2,
          allowed_count: 2,
          blocked_count: 0,
          anomaly_score: 0,
        },
        {
          source: 'app01',
          target: 'dns01',
          app: 'dns-forwarder',
          protocol: 'udp',
          dst_port: 53,
          bytes: 512,
          connections: 1,
          allowed_count: 1,
          blocked_count: 0,
          anomaly_score: 0,
        },
      ],
    } as any)

    renderPage({ initialPath: '/network?app=dns-forwarder&protocol=udp' })

    expect(await screen.findByText(/1\s+Verbindung/, { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'App-Filter' })).toHaveValue('dns-forwarder')
    expect(screen.getByRole('combobox', { name: 'Protokoll-Filter' })).toHaveValue('udp')
    expect(screen.queryByRole('link', { name: 'Events app01 nach db01' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Events app01 nach dns01' })).toBeInTheDocument()
  })

  test('hydrates the selected time window from URL query params', async () => {
    renderPage({ initialPath: '/network?window=168' })

    expect(await screen.findByRole('button', { name: 'Zeitfenster 7 d' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/Fenster: 7 d/)).toBeInTheDocument()
  })
})