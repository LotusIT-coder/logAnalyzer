import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import RulesPage from '../pages/RulesPage'
import { SourceFilterProvider } from '../ctx/SourceFilterContext'

vi.mock('../lib/requests', () => ({
  getRules: vi.fn(),
  createRule: vi.fn(),
  patchRule: vi.fn(),
}))

import { getRules, type RuleListResponse } from '../lib/requests'

const mockGetRules = vi.mocked(getRules)

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <SourceFilterProvider>
        <RulesPage />
      </SourceFilterProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetRules.mockResolvedValue({
    items: [
      { id: 'rule-1', name: 'Error burst', severity: 'error', threshold: 5, window_seconds: 300, enabled: true },
    ],
  } satisfies RuleListResponse)
})

describe('RulesPage', () => {
  test('renders contextual help for rule configuration and listing', async () => {
    renderPage()

    expect(await screen.findByLabelText('Regeln erklaeren')).toBeInTheDocument()
    expect(await screen.findByText('Error burst')).toBeInTheDocument()
    expect(screen.getByLabelText('Regelliste erklaeren')).toBeInTheDocument()
  })
})