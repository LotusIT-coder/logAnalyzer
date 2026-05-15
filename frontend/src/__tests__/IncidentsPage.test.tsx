import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import IncidentsPage from '../pages/IncidentsPage'

vi.mock('../lib/requests', () => ({
  getIncidents: vi.fn(),
  patchIncident: vi.fn(),
}))

import { getIncidents, type IncidentListResponse } from '../lib/requests'

const mockGetIncidents = vi.mocked(getIncidents)

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <IncidentsPage />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.setItem('kibana.baseUrl', 'http://localhost:5601')
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
        rule_id: '4a560f0f-a12b-4ebf-9bd6-2ad0d98814a1',
        mitre_tactic: 'execution',
        mitre_techniques: ['T1059.001', 'T1105'],
        confidence_score: 0.93,
        confidence_rationale: 'threshold=4/2, sequence_completeness=1.00, signal_strength=0.95',
      },
    ],
  } satisfies IncidentListResponse)
})

describe('IncidentsPage', () => {
  test('renders contextual help for search, status filtering and incident overview', async () => {
    renderPage()

    expect(await screen.findByLabelText('Incidents erklaeren')).toBeInTheDocument()
    expect(screen.getByLabelText('Titelsuche erklaeren')).toBeInTheDocument()
    expect(screen.getByLabelText('Statusfilter erklaeren')).toBeInTheDocument()
    expect(await screen.findByText('DNS saturation')).toBeInTheDocument()
    expect(screen.getByLabelText('Incidentliste erklaeren')).toBeInTheDocument()
    expect(screen.getByLabelText('Confidence Legende')).toBeInTheDocument()
    expect(screen.getByText('hoch')).toBeInTheDocument()
    expect(screen.getByText('mittel')).toBeInTheDocument()
    expect(screen.getByText('niedrig')).toBeInTheDocument()
    expect(screen.getByText('Confidence: 93% (hoch)')).toBeInTheDocument()
    expect(screen.getByLabelText('Confidence rationale')).toBeInTheDocument()
    expect(screen.getByLabelText('Detection Chain')).toBeInTheDocument()
    expect(screen.getByText('Event (4)')).toBeInTheDocument()
    expect(screen.getByText('Rule 4a560f0f')).toBeInTheDocument()
    expect(screen.getByText('execution: T1059.001, T1105')).toBeInTheDocument()
    const kibanaLink = screen.getByLabelText('In Kibana öffnen') as HTMLAnchorElement
    expect(kibanaLink).toBeInTheDocument()
    expect(kibanaLink.href).toContain('http://localhost:5601/app/discover')
    expect(kibanaLink.href).toContain('_g=')
    expect(kibanaLink.href).toContain('_a=')
  })
})