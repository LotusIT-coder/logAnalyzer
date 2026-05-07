/**
 * Unit tests for API request functions in requests.ts.
 * Axios is mocked so no real HTTP calls are made.
 */
import { vi } from 'vitest'

import type { CreateTokenRequest, CreateUserRequest } from '../lib/requests'

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
  loginWithPassword,
  getMe,
  getEvents,
  getIncidents,
  patchIncident,
  getRules,
  createRule,
  patchRule,
  getUsers,
  createUser,
  getTokens,
  createToken,
  revokeToken,
  getNetworkMap,
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

describe('getMe', () => {
  test('returns current subject, role and scopes', async () => {
    mockGet.mockResolvedValueOnce({
      data: { subject: 'admin@example.com', role: 'admin', scopes: ['admin'], user_id: 'user-1' },
    } as any)

    const result = await getMe()

    expect(mockGet).toHaveBeenCalledWith('/auth/me')
    expect(result.role).toBe('admin')
    expect(result.user_id).toBe('user-1')
  })
})

describe('loginWithPassword', () => {
  test('POSTs credentials to auth login endpoint', async () => {
    mockPost.mockResolvedValueOnce({ data: { token: 'secret', token_id: 't1' } } as any)

    const result = await loginWithPassword({ email: 'alice@example.com', password: 'Str0ng!Pass' })

    expect(mockPost).toHaveBeenCalledWith('/auth/login', { email: 'alice@example.com', password: 'Str0ng!Pass' })
    expect(result.token).toBe('secret')
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

describe('getUsers', () => {
  test('returns user list payload', async () => {
    mockGet.mockResolvedValueOnce({ data: { items: [{ id: 'u1' }] } } as any)
    const result = await getUsers()
    expect(mockGet).toHaveBeenCalledWith('/auth/users')
    expect(result.items).toHaveLength(1)
  })
})

describe('createUser', () => {
  test('POSTs a new user payload', async () => {
    const payload: CreateUserRequest = { name: 'Alice', email: 'alice@example.com', password: 'Str0ng!Pass', role: 'analyst', enabled: true }
    mockPost.mockResolvedValueOnce({ data: { id: 'u1', ...payload } } as any)
    const result = await createUser(payload)
    expect(mockPost).toHaveBeenCalledWith('/auth/users', payload)
    expect(result.id).toBe('u1')
  })
})

describe('getTokens', () => {
  test('returns issued tokens', async () => {
    mockGet.mockResolvedValueOnce({ data: { items: [{ id: 't1' }] } } as any)
    const result = await getTokens()
    expect(mockGet).toHaveBeenCalledWith('/auth/tokens')
    expect(result.items).toHaveLength(1)
  })
})

describe('createToken', () => {
  test('POSTs token request to auth endpoint', async () => {
    const payload: CreateTokenRequest = { name: 'ops', role: 'operator', user_id: 'u1' }
    mockPost.mockResolvedValueOnce({ data: { token: 'secret', token_id: 't1' } } as any)
    const result = await createToken(payload)
    expect(mockPost).toHaveBeenCalledWith('/auth/token', payload)
    expect(result.token_id).toBe('t1')
  })
})

describe('revokeToken', () => {
  test('POSTs revoke request for token id', async () => {
    mockPost.mockResolvedValueOnce({ data: { id: 't1', revoked_at: '2026-05-06T10:00:00Z' } } as any)
    const result = await revokeToken('t1')
    expect(mockPost).toHaveBeenCalledWith('/auth/tokens/t1/revoke')
    expect(result.id).toBe('t1')
  })
})

describe('getNetworkMap', () => {
  test('GETs aggregated network graph with metrics filters', async () => {
    mockGet.mockResolvedValueOnce({ data: { nodes: [], edges: [] } } as any)

    const result = await getNetworkMap(
      { from: '2026-05-06T10:00:00Z', to: '2026-05-06T11:00:00Z' },
      { sourceIds: ['src-1'], sourcePaths: ['/var/log/firewall.log'] },
    )

    expect(mockGet).toHaveBeenCalledWith('/metrics/network/map', {
      params: {
        from: '2026-05-06T10:00:00Z',
        to: '2026-05-06T11:00:00Z',
        source_ids: 'src-1',
        source_paths: '/var/log/firewall.log',
      },
    })
    expect(result).toEqual({ nodes: [], edges: [] })
  })
})

describe('aiChatAsync', () => {
  test('POSTs async AI chat request with attached context payload', async () => {
    mockPost.mockResolvedValueOnce({ data: { job_id: 'job-1' } } as any)

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
