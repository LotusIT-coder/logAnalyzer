/**
 * Unit tests for api.ts helper functions.
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

import { getApiBase } from '../lib/api'

describe('getApiBase', () => {
  test('uses default /api/v1 when no environment override exists', () => {
    expect(getApiBase()).toBe('/api/v1')
  })
})
