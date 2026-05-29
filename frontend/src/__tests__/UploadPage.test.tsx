import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

import UploadPage from '../pages/UploadPage'
import { I18nProvider } from '../ctx/I18nContext'

vi.mock('../lib/requests', () => ({
  getAIModels: vi.fn(),
  analyzeUpload: vi.fn(),
  uploadImport: vi.fn(),
}))

import { analyzeUpload, getAIModels, uploadImport, type AIModelResponse, type UploadImportResponse } from '../lib/requests'

const mockGetAIModels = vi.mocked(getAIModels)
const mockAnalyzeUpload = vi.mocked(analyzeUpload)
const mockUploadImport = vi.mocked(uploadImport)

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <UploadPage />
      </I18nProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.setItem('ui-language', 'de')
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
  test('allows importing uploaded files as sources', async () => {
    renderPage()

    const file = new File(['level=error msg="boom"'], 'sample.log', { type: 'text/plain' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })

    fireEvent.click(await screen.findByRole('button', { name: /In Quelle importieren|upload\.importToSource/i }))

    await waitFor(() => {
      expect(mockUploadImport).toHaveBeenCalledWith(file, undefined)
    })

    expect(await screen.findByText('Import abgeschlossen')).toBeInTheDocument()
    expect(screen.getByText(/Quelle:\s*Upload: sample\.log/)).toBeInTheDocument()
  })
})