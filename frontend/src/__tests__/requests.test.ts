/**
 * Unit tests for API request functions in requests.ts.
 * Axios is mocked so no real HTTP calls are made.
 */
import { vi } from 'vitest'

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
  getSources,
  createSource,
  patchSource,
  deleteSource,
  getEvents,
  getIncidents,
  patchIncident,
  getRules,
  createRule,
  patchRule,
} from '../lib/requests'

const mockGet = vi.mocked(api.get)
const mockPost = vi.mocked(api.post)
const mockPatch = vi.mocked(api.patch)
const mockDelete = vi.mocked(api.delete)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getSources', () => {
  test('returns items array from response', async () => {
    const items = [{ id: '1', name: 'syslog' }]
    mockGet.mockResolvedValueOnce({ data: { items } } as any)
    const result = await getSources()
    expect(mockGet).toHaveBeenCalledWith('/sources')
    expect(result).toEqual(items)
  })

  test('falls back to raw array if no items wrapper', async () => {
    const arr = [{ id: '2', name: 'auth.log' }]
    mockGet.mockResolvedValueOnce({ data: arr } as any)
    const result = await getSources()
    expect(result).toEqual(arr)
  })
})

describe('createSource', () => {
  test('POSTs to /sources and returns created source', async () => {
    const payload = { name: 'test', type: 'file', config: { path: '/tmp/x.log' }, enabled: true }
    const created = { id: 'abc', ...payload }
    mockPost.mockResolvedValueOnce({ data: created } as any)
    const result = await createSource(payload)
    expect(mockPost).toHaveBeenCalledWith('/sources', payload)
    expect(result).toEqual(created)
  })
})

describe('patchSource', () => {
  test('PATCHes /sources/{id} with body', async () => {
    const patched = { id: 'abc', name: 'new-name' }
    mockPatch.mockResolvedValueOnce({ data: patched } as any)
    const result = await patchSource('abc', { name: 'new-name' })
    expect(mockPatch).toHaveBeenCalledWith('/sources/abc', { name: 'new-name' })
    expect(result).toEqual(patched)
  })
})

describe('deleteSource', () => {
  test('DELETEs /sources/{id}', async () => {
    mockDelete.mockResolvedValueOnce({} as any)
    await deleteSource('abc')
    expect(mockDelete).toHaveBeenCalledWith('/sources/abc')
  })
})

describe('getEvents', () => {
  test('returns items and next_cursor', async () => {
    const resp = { items: [{ id: 'e1', message: 'hello' }], next_cursor: null }
    mockGet.mockResolvedValueOnce({ data: resp } as any)
    const result = await getEvents()
    expect(mockGet).toHaveBeenCalledWith('/events', { params: undefined })
    expect(result.items).toHaveLength(1)
  })

  test('passes params to GET request', async () => {
    mockGet.mockResolvedValueOnce({ data: { items: [] } } as any)
    await getEvents({ severity: 'error', limit: 50 })
    expect(mockGet).toHaveBeenCalledWith('/events', { params: { severity: 'error', limit: 50 } })
  })
})

describe('getIncidents', () => {
  test('returns incidents list', async () => {
    mockGet.mockResolvedValueOnce({ data: { items: [] } } as any)
    const result = await getIncidents()
    expect(mockGet).toHaveBeenCalledWith('/incidents', { params: undefined })
    expect(result).toEqual({ items: [] })
  })
})

describe('patchIncident', () => {
  test('PATCHes incident status', async () => {
    mockPatch.mockResolvedValueOnce({ data: { id: 'i1', status: 'resolved' } } as any)
    const result = await patchIncident('i1', { status: 'resolved' })
    expect(mockPatch).toHaveBeenCalledWith('/incidents/i1', { status: 'resolved' })
    expect(result.status).toBe('resolved')
  })
})

describe('getRules', () => {
  test('returns rules list', async () => {
    mockGet.mockResolvedValueOnce({ data: { items: [{ id: 'r1' }] } } as any)
    const result = await getRules()
    expect(result.items).toHaveLength(1)
  })
})

describe('createRule', () => {
  test('POSTs rule body', async () => {
    const rule = { name: 'test rule', condition: {}, threshold: 5, window_seconds: 60, severity: 'warning', enabled: true }
    mockPost.mockResolvedValueOnce({ data: { id: 'r1', ...rule } } as any)
    const result = await createRule(rule)
    expect(mockPost).toHaveBeenCalledWith('/rules', rule)
    expect(result.id).toBe('r1')
  })
})

describe('patchRule', () => {
  test('PATCHes rule threshold', async () => {
    mockPatch.mockResolvedValueOnce({ data: { id: 'r1', threshold: 10 } } as any)
    const result = await patchRule('r1', { threshold: 10 })
    expect(mockPatch).toHaveBeenCalledWith('/rules/r1', { threshold: 10 })
    expect(result.threshold).toBe(10)
  })
})
