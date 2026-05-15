/**
 * Unit tests for API request functions in requests.ts.
 * Axios is mocked so no real HTTP calls are made.
 */
import { vi } from 'vitest'

import type {
  EventListResponse,
  IncidentListResponse,
  RuleListResponse,
  SourceResponse,
} from '../lib/requests'

// Mock the api module before importing requests
vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))

import { api } from '../lib/api'
import {
  aiChatAsync,
  getSources,
  createSource,
  patchSource,
  deleteSource,
  getEvents,
  getIncidents,
  getMitreCoverage,
  patchIncident,
  getRules,
  createRule,
  patchRule,
} from '../lib/requests'

const mockGet = vi.mocked(api.get)
const mockPost = vi.mocked(api.post)
const mockPatch = vi.mocked(api.patch)
const mockDelete = vi.mocked(api.delete)

type ApiResponse = Awaited<ReturnType<typeof api.get>>

function mockApiResponse<T>(data: T): ApiResponse {
  return { data } as unknown as ApiResponse
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getSources', () => {
  test('returns items array from response', async () => {
    const items: SourceResponse[] = [{ id: '1', name: 'syslog', type: 'file', enabled: true, config: { path: '/var/log/syslog' } }]
    mockGet.mockResolvedValueOnce(mockApiResponse({ items }))
    const result = await getSources()
    expect(mockGet).toHaveBeenCalledWith('/sources')
    expect(result).toEqual(items)
  })

  test('falls back to raw array if no items wrapper', async () => {
    const arr: SourceResponse[] = [{ id: '2', name: 'auth.log', type: 'file', enabled: true, config: { path: '/var/log/auth.log' } }]
    mockGet.mockResolvedValueOnce(mockApiResponse(arr))
    const result = await getSources()
    expect(result).toEqual(arr)
  })
})

describe('createSource', () => {
  test('POSTs to /sources and returns created source', async () => {
    const payload = { name: 'test', type: 'file', config: { path: '/tmp/x.log' }, enabled: true }
    const created = { id: 'abc', ...payload }
    mockPost.mockResolvedValueOnce(mockApiResponse(created))
    const result = await createSource(payload)
    expect(mockPost).toHaveBeenCalledWith('/sources', payload)
    expect(result).toEqual(created)
  })
})

describe('patchSource', () => {
  test('PATCHes /sources/{id} with body', async () => {
    const patched = { id: 'abc', name: 'new-name', type: 'file', enabled: true, config: { path: '/tmp/x.log' } }
    mockPatch.mockResolvedValueOnce(mockApiResponse(patched))
    const result = await patchSource('abc', { name: 'new-name' })
    expect(mockPatch).toHaveBeenCalledWith('/sources/abc', { name: 'new-name' })
    expect(result).toEqual(patched)
  })
})

describe('deleteSource', () => {
  test('DELETEs /sources/{id}', async () => {
    mockDelete.mockResolvedValueOnce(mockApiResponse(undefined))
    await deleteSource('abc')
    expect(mockDelete).toHaveBeenCalledWith('/sources/abc')
  })
})

describe('getEvents', () => {
  test('returns items and next_cursor', async () => {
    const resp: EventListResponse = { items: [{ id: 'e1', timestamp: '2026-05-06T10:00:00Z', severity: 'info', message: 'hello' }], next_cursor: null }
    mockGet.mockResolvedValueOnce(mockApiResponse(resp))
    const result = await getEvents()
    expect(mockGet).toHaveBeenCalledWith('/events', { params: undefined })
    expect(result.items).toHaveLength(1)
  })

  test('passes params to GET request', async () => {
    mockGet.mockResolvedValueOnce(mockApiResponse({ items: [] } satisfies EventListResponse))
    await getEvents({ severity: 'error', limit: 50 })
    expect(mockGet).toHaveBeenCalledWith('/events', { params: { severity: 'error', limit: 50 } })
  })
})

describe('getIncidents', () => {
  test('returns incidents list', async () => {
    mockGet.mockResolvedValueOnce(mockApiResponse({ items: [] } satisfies IncidentListResponse))
    const result = await getIncidents()
    expect(mockGet).toHaveBeenCalledWith('/incidents', { params: undefined })
    expect(result).toEqual({ items: [] })
  })
})

describe('getMitreCoverage', () => {
  test('returns MITRE coverage summary', async () => {
    mockGet.mockResolvedValueOnce(mockApiResponse({
      items: [{ technique_id: 'T1110', tactic: 'credential-access', rule_count: 1, incident_count: 2 }],
      mapped_rules: 1,
      mapped_incidents: 2,
    }))
    const result = await getMitreCoverage()
    expect(mockGet).toHaveBeenCalledWith('/incidents/mitre-coverage')
    expect(result.mapped_rules).toBe(1)
    expect(result.items[0].technique_id).toBe('T1110')
  })
})

describe('patchIncident', () => {
  test('PATCHes incident status', async () => {
    mockPatch.mockResolvedValueOnce(mockApiResponse({ id: 'i1', title: 'Incident', status: 'resolved', severity: 'warning', event_count: 1, first_seen: '2026-05-06T10:00:00Z', last_seen: '2026-05-06T10:01:00Z' }))
    const result = await patchIncident('i1', { status: 'resolved' })
    expect(mockPatch).toHaveBeenCalledWith('/incidents/i1', { status: 'resolved' })
    expect(result.status).toBe('resolved')
  })
})

describe('getRules', () => {
  test('returns rules list', async () => {
    mockGet.mockResolvedValueOnce(mockApiResponse({ items: [{ id: 'r1', name: 'Rule', severity: 'warning', threshold: 2, window_seconds: 60, enabled: true }] } satisfies RuleListResponse))
    const result = await getRules()
    expect(result.items).toHaveLength(1)
  })
})

describe('createRule', () => {
  test('POSTs rule body', async () => {
    const rule = { name: 'test rule', condition: {}, threshold: 5, window_seconds: 60, severity: 'warning', enabled: true }
    mockPost.mockResolvedValueOnce(mockApiResponse({ id: 'r1', ...rule }))
    const result = await createRule(rule)
    expect(mockPost).toHaveBeenCalledWith('/rules', rule)
    expect(result.id).toBe('r1')
  })
})

describe('patchRule', () => {
  test('PATCHes rule threshold', async () => {
    mockPatch.mockResolvedValueOnce(mockApiResponse({ id: 'r1', name: 'Rule', severity: 'warning', threshold: 10, window_seconds: 60, enabled: true }))
    const result = await patchRule('r1', { threshold: 10 })
    expect(mockPatch).toHaveBeenCalledWith('/rules/r1', { threshold: 10 })
    expect(result.threshold).toBe(10)
  })
})

describe('aiChatAsync', () => {
  test('POSTs async AI chat request with attached context payload', async () => {
    mockPost.mockResolvedValueOnce(mockApiResponse({ job_id: 'job-1' }))

    const result = await aiChatAsync('qwen3:8b', 'Bitte analysiere das Netzwerk.', {
      sourceIds: ['src-1'],
      sourcePaths: ['/var/log/syslog'],
      rangeHours: 6,
      context: {
        kind: 'network_edges',
        title: 'Netzwerk-Verbindungen',
        summary: 'Topologische Zusammenfassung',
        details: { total_edges: 11 },
      },
    })

    expect(mockPost).toHaveBeenCalledWith('/ai/chat/async', {
      message: 'Bitte analysiere das Netzwerk.',
      model: 'qwen3:8b',
      source_ids: ['src-1'],
      source_paths: ['/var/log/syslog'],
      since_hours: 6,
      context: {
        kind: 'network_edges',
        title: 'Netzwerk-Verbindungen',
        summary: 'Topologische Zusammenfassung',
        details: { total_edges: 11 },
      },
    })
    expect(result).toEqual({ job_id: 'job-1' })
  })
})
