import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'

import { AppRoutes } from '../App'
import { AuthProvider } from '../ctx/AuthContext'
import { AIChatProvider } from '../ctx/AIChatContext'
import { SourceFilterProvider } from '../ctx/SourceFilterContext'

function renderRoutes(initialPath: string, me: { subject: string; role: 'viewer' | 'analyst' | 'operator' | 'admin'; scopes: string[] } | null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider value={{ me, isLoading: false, login: vi.fn(), logout: vi.fn() }}>
        <SourceFilterProvider>
          <AIChatProvider>
            <MemoryRouter initialEntries={[initialPath]}>
              <AppRoutes />
            </MemoryRouter>
          </AIChatProvider>
        </SourceFilterProvider>
      </AuthProvider>
    </QueryClientProvider>
  )
}

describe('AppRoutes', () => {
  test('redirects unauthenticated users to login', async () => {
    renderRoutes('/access', null)

    expect(await screen.findByRole('heading', { name: 'Log Analyzer' })).toBeInTheDocument()
    expect(screen.getByLabelText('E-Mail')).toBeInTheDocument()
    expect(screen.getByLabelText('Passwort')).toBeInTheDocument()
  })
})