import { act, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('../lib/api', () => ({
  setToken: vi.fn(),
  clearToken: vi.fn(),
  loadStoredToken: vi.fn(),
}))

vi.mock('../lib/requests', async () => {
  const actual = await vi.importActual('../lib/requests')
  return {
    ...actual,
    getMe: vi.fn(),
  }
})

import { loadStoredToken, clearToken } from '../lib/api'
import { getMe } from '../lib/requests'
import { AuthProvider, useAuth } from '../ctx/AuthContext'

const mockLoadStoredToken = vi.mocked(loadStoredToken)
const mockClearToken = vi.mocked(clearToken)
const mockGetMe = vi.mocked(getMe)

function Probe() {
  const { me, isLoading, logout } = useAuth()

  return (
    <div>
      <div>{isLoading ? 'loading' : me?.subject ?? 'anonymous'}</div>
      <button onClick={logout}>logout</button>
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AuthProvider', () => {
  test('loads current principal from stored token on mount', async () => {
    mockLoadStoredToken.mockReturnValue('stored-token')
    mockGetMe.mockResolvedValue({
      subject: 'admin@example.com',
      role: 'admin',
      scopes: ['admin'],
      user_id: 'user-1',
    })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    expect(screen.getByText('loading')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('admin@example.com')).toBeInTheDocument()
    })

    expect(mockGetMe).toHaveBeenCalledTimes(1)
  })

  test('clears invalid stored tokens', async () => {
    mockLoadStoredToken.mockReturnValue('broken-token')
    mockGetMe.mockRejectedValue({ response: { status: 401 } })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => {
      expect(screen.getByText('anonymous')).toBeInTheDocument()
    })

    expect(mockClearToken).toHaveBeenCalledTimes(1)
  })

  test('retries session bootstrap without clearing the stored token on transient failures', async () => {
    vi.useFakeTimers()
    mockLoadStoredToken.mockReturnValue('stored-token')
    mockGetMe
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({
        subject: 'admin@example.com',
        role: 'admin',
        scopes: ['admin'],
        user_id: 'user-1',
      })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    expect(screen.getByText('loading')).toBeInTheDocument()

    await act(async () => {
      await Promise.resolve()
    })

    expect(mockGetMe).toHaveBeenCalledTimes(1)
    expect(mockClearToken).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })

    expect(mockGetMe).toHaveBeenCalledTimes(2)
    expect(screen.getByText('admin@example.com')).toBeInTheDocument()
    expect(mockClearToken).not.toHaveBeenCalled()
  })
})