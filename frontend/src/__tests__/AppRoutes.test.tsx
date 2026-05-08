import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { AppRoutes } from '../App'
import { AIChatProvider } from '../ctx/AIChatContext'
import { SourceFilterProvider } from '../ctx/SourceFilterContext'

function renderRoutes(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  render(
    <QueryClientProvider client={queryClient}>
      <SourceFilterProvider>
        <AIChatProvider>
          <MemoryRouter initialEntries={[initialPath]}>
            <AppRoutes />
          </MemoryRouter>
        </AIChatProvider>
      </SourceFilterProvider>
    </QueryClientProvider>
  )
}

describe('AppRoutes', () => {
  test('redirects unknown route to dashboard', async () => {
    renderRoutes('/does-not-exist')

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
  })
})