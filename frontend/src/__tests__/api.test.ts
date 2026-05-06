/**
 * Unit tests for api.ts helper functions (token management).
 * Uses vi.stubGlobal for localStorage since jsdom provides it.
 */
import { vi } from 'vitest'

// Mock axios to avoid real HTTP
vi.mock('axios', () => {
  const instance = {
    defaults: { headers: { common: {} as Record<string, string> } },
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }
  return {
    default: {
      create: vi.fn(() => instance),
    },
  }
})

import { api, setToken, clearToken, loadStoredToken } from '../lib/api'

beforeEach(() => {
  localStorage.clear()
  // Reset Authorization header between tests
  delete (api.defaults.headers.common as Record<string, string>)['Authorization']
})

describe('setToken', () => {
  test('sets Authorization header', () => {
    setToken('my-token')
    expect(api.defaults.headers.common['Authorization']).toBe('Bearer my-token')
  })

  test('persists token to localStorage', () => {
    setToken('my-token')
    expect(localStorage.getItem('api_token')).toBe('my-token')
  })
})

describe('clearToken', () => {
  test('removes Authorization header', () => {
    setToken('my-token')
    clearToken()
    expect(api.defaults.headers.common['Authorization']).toBeUndefined()
  })

  test('removes token from localStorage', () => {
    setToken('my-token')
    clearToken()
    expect(localStorage.getItem('api_token')).toBeNull()
  })
})

describe('loadStoredToken', () => {
  test('returns null when no token stored', () => {
    const t = loadStoredToken()
    expect(t).toBeNull()
  })

  test('restores token from localStorage and sets header', () => {
    localStorage.setItem('api_token', 'stored-token')
    const t = loadStoredToken()
    expect(t).toBe('stored-token')
    expect(api.defaults.headers.common['Authorization']).toBe('Bearer stored-token')
  })
})
