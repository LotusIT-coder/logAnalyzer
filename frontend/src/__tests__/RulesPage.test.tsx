import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import RulesPage from '../pages/RulesPage'
import { SourceFilterProvider } from '../ctx/SourceFilterContext'
import { I18nProvider } from '../ctx/I18nContext'

vi.mock('../lib/requests', () => ({
  getRules: vi.fn(),
  createRule: vi.fn(),
  patchRule: vi.fn(),
  getSources: vi.fn(),
}))

import { getRules, getSources, type RuleListResponse, type SourceResponse } from '../lib/requests'

const mockGetRules = vi.mocked(getRules)
const mockGetSources = vi.mocked(getSources)

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <SourceFilterProvider>
          <RulesPage />
        </SourceFilterProvider>
      </I18nProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.setItem('ui-language', 'de')
  mockGetSources.mockResolvedValue([] as SourceResponse[])
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