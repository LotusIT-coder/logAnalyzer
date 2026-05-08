import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

import UploadPage from '../pages/UploadPage'
import { AuthProvider } from '../ctx/AuthContext'

vi.mock('../lib/requests', () => ({
  getAIModels: vi.fn(),
  analyzeUpload: vi.fn(),
  uploadImport: vi.fn(),
}))

import { analyzeUpload, getAIModels, uploadImport, type AIModelResponse, type UploadImportResponse } from '../lib/requests'

const mockGetAIModels = vi.mocked(getAIModels)
const mockAnalyzeUpload = vi.mocked(analyzeUpload)
const mockUploadImport = vi.mocked(uploadImport)

function renderPage(role: 'viewer' | 'analyst' | 'operator' | 'admin' = 'viewer') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider
        value={{
          me: { subject: `${role}@example.com`, role, scopes: role === 'viewer' ? ['read'] : ['write'] },
          isLoading: false,
          login: vi.fn(),
          logout: vi.fn(),
        }}
      >
        <UploadPage />
      </AuthProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetAIModels.mockResolvedValue([{ name: 'qwen3.5:9b' }] satisfies AIModelResponse[])
  mockAnalyzeUpload.mockResolvedValue({
    lines_parsed: 10,
    events_found: 3,
    model: 'qwen3.5:9b',
    analysis: 'Analyse ok',
  })
  mockUploadImport.mockResolvedValue({
    source_id: 'source-1',
    source_name: 'Upload: sample.log',
    stored_path: '/tmp/sample.log',
    lines_ingested: 10,
    events_created: 3,
  } satisfies UploadImportResponse)
})

describe('UploadPage', () => {
  test('shows analyze-only mode for viewers', async () => {
    renderPage('viewer')

    expect(await screen.findByText('Analyse-only: Dieses Token darf Uploads pruefen, aber nicht importieren.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'In Quelle importieren' })).not.toBeInTheDocument()
  })

  test('allows writers to import uploaded files as sources', async () => {
    renderPage('analyst')

    const file = new File(['level=error msg="boom"'], 'sample.log', { type: 'text/plain' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })

    fireEvent.click(await screen.findByRole('button', { name: 'In Quelle importieren' }))

    await waitFor(() => {
      expect(mockUploadImport).toHaveBeenCalledWith(file, undefined)
    })

    expect(await screen.findByText('Import abgeschlossen')).toBeInTheDocument()
    expect(screen.getByText(/Quelle:\s*Upload: sample\.log/)).toBeInTheDocument()
  })
})