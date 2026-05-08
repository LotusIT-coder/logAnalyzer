import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

import AccessPage from '../pages/AccessPage'
import { AuthProvider } from '../ctx/AuthContext'

vi.mock('../lib/requests', () => ({
  getUsers: vi.fn(),
  createUser: vi.fn(),
  getTokens: vi.fn(),
  createToken: vi.fn(),
  revokeToken: vi.fn(),
}))

import {
  getUsers,
  createUser,
  getTokens,
  createToken,
  revokeToken,
  type CreateTokenResponse,
  type TokenListItem,
  type TokenListResponse,
  type UserListResponse,
  type UserResponse,
} from '../lib/requests'

const mockGetUsers = vi.mocked(getUsers)
const mockCreateUser = vi.mocked(createUser)
const mockGetTokens = vi.mocked(getTokens)
const mockCreateToken = vi.mocked(createToken)
const mockRevokeToken = vi.mocked(revokeToken)

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider
        value={{
          me: { subject: 'admin@example.com', role: 'admin', scopes: ['admin'] },
        }}
      >
        <AccessPage />
      </AuthProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetUsers.mockResolvedValue({
    items: [
      {
        id: 'user-1',
        name: 'Alice Analyst',
        email: 'alice@example.com',
        role: 'analyst',
        enabled: true,
      },
    ],
  } satisfies UserListResponse)
  mockGetTokens.mockResolvedValue({
    items: [
      {
        id: 'token-1',
        name: 'Ops token',
        role: 'operator',
        user_id: 'user-1',
        scopes: ['events:read'],
        created_at: '2026-05-06T10:00:00Z',
        revoked_at: null,
      },
    ],
  } satisfies TokenListResponse)
  mockCreateUser.mockResolvedValue({
    id: 'user-2',
    name: 'Bob Builder',
    email: 'bob@example.com',
    role: 'operator',
    enabled: true,
  } satisfies UserResponse)
  mockCreateToken.mockResolvedValue({
    token: 'secret-token-value',
    token_id: 'token-2',
  } satisfies CreateTokenResponse)
  mockRevokeToken.mockResolvedValue({
    id: 'token-1',
    name: 'Ops token',
    role: 'operator',
    user_id: 'user-1',
    scopes: ['events:read'],
    created_at: '2026-05-06T10:00:00Z',
    revoked_at: '2026-05-06T10:30:00Z',
  } satisfies TokenListItem)
})

describe('AccessPage', () => {
  test('loads users and tokens and allows admin actions', async () => {
    renderPage()

    expect((await screen.findAllByText('Alice Analyst')).length).toBeGreaterThan(0)
    expect(screen.getByText('Ops token')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'Bob Builder' } })
    fireEvent.change(screen.getByLabelText('E-Mail'), { target: { value: 'bob@example.com' } })
    fireEvent.change(screen.getByLabelText('Initiales Passwort'), { target: { value: 'B0b!Secure' } })
    fireEvent.change(screen.getByLabelText('Benutzerrolle'), { target: { value: 'operator' } })
    fireEvent.click(screen.getByRole('button', { name: 'Benutzer anlegen' }))

    await waitFor(() => {
      expect(mockCreateUser).toHaveBeenCalledWith({
        name: 'Bob Builder',
        email: 'bob@example.com',
        password: 'B0b!Secure',
        role: 'operator',
        enabled: true,
      })
    })

    fireEvent.change(screen.getByLabelText('Token-Name'), { target: { value: 'Night shift' } })
    fireEvent.change(screen.getByLabelText('Token-Rolle'), { target: { value: 'analyst' } })
    fireEvent.change(screen.getByLabelText('Zugeordneter Benutzer'), { target: { value: 'user-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Token erzeugen' }))

    await waitFor(() => {
      expect(mockCreateToken).toHaveBeenCalledWith({
        name: 'Night shift',
        role: 'analyst',
        user_id: 'user-1',
      })
    })

    expect(await screen.findByText('secret-token-value')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Token widerrufen' }))

    await waitFor(() => {
      expect(mockRevokeToken).toHaveBeenCalledWith('token-1')
    })
  })

  test('blocks non-admin users', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider value={{ me: { subject: 'viewer@example.com', role: 'viewer', scopes: ['events:read'] } }}>
          <AccessPage />
        </AuthProvider>
      </QueryClientProvider>
    )

    expect(screen.getByText('Dieser Bereich ist nur fuer Administratoren sichtbar.')).toBeInTheDocument()
  })
})