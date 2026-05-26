/**
 * Unit tests for SourceFilterContext.
 * Verifies state management: filter, selectedSources, customSources, clearFilter.
 */
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SourceFilterProvider } from '../ctx/SourceFilterContext'
import { type SourceOption } from '../ctx/SourceFilterContext.shared'
import { useSourceFilter } from '../ctx/useSourceFilter'

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={queryClient}>
      <SourceFilterProvider>{children}</SourceFilterProvider>
    </QueryClientProvider>
  )
}

const SAMPLE_SOURCE: SourceOption = {
  id: 'source:abc-123',
  label: 'syslog',
  path: '/var/log/syslog',
  kind: 'configured',
}

describe('SourceFilterContext', () => {
  test('initial filter is empty', () => {
    const { result } = renderHook(() => useSourceFilter(), { wrapper })
    expect(result.current.filter.sourceIds).toEqual([])
    expect(result.current.filter.sourcePaths).toEqual([])
    expect(result.current.filter.rangeHours).toBe(24)
    expect(result.current.filter.severities).toEqual([])
    expect(result.current.hasFilter).toBe(false)
  })

  test('setFilter updates state and hasFilter', () => {
    const { result } = renderHook(() => useSourceFilter(), { wrapper })
    act(() => {
      result.current.setFilter({ sourceIds: ['abc'], sourcePaths: [], rangeHours: 24, severities: [] })
    })
    expect(result.current.filter.sourceIds).toEqual(['abc'])
    expect(result.current.filter.rangeHours).toBe(24)
    expect(result.current.hasFilter).toBe(true)
  })

  test('setFilter deduplicates sourceIds', () => {
    const { result } = renderHook(() => useSourceFilter(), { wrapper })
    act(() => {
      result.current.setFilter({ sourceIds: ['x', 'x', 'y'], sourcePaths: [], rangeHours: 1, severities: [] })
    })
    expect(result.current.filter.sourceIds).toEqual(['x', 'y'])
  })

  test('setSelectedSources stores options', () => {
    const { result } = renderHook(() => useSourceFilter(), { wrapper })
    act(() => {
      result.current.setSelectedSources([SAMPLE_SOURCE])
    })
    expect(result.current.selectedSources).toHaveLength(1)
    expect(result.current.selectedSources[0].id).toBe('source:abc-123')
  })

  test('setCustomSources stores custom options', () => {
    const { result } = renderHook(() => useSourceFilter(), { wrapper })
    const custom: SourceOption = { id: 'custom:/tmp/app.log', label: '/tmp/app.log', path: '/tmp/app.log', kind: 'custom' }
    act(() => {
      result.current.setCustomSources([custom])
    })
    expect(result.current.customSources[0].kind).toBe('custom')
  })

  test('clearFilter resets everything', () => {
    const { result } = renderHook(() => useSourceFilter(), { wrapper })
    act(() => {
      result.current.setFilter({ sourceIds: ['abc'], sourcePaths: ['/var/log/syslog'], rangeHours: 12, severities: [] })
      result.current.setSelectedSources([SAMPLE_SOURCE])
    })
    act(() => {
      result.current.clearFilter()
    })
    expect(result.current.filter.sourceIds).toEqual([])
    expect(result.current.filter.sourcePaths).toEqual([])
    expect(result.current.filter.rangeHours).toBe(24)
    expect(result.current.filter.severities).toEqual([])
    expect(result.current.selectedSources).toEqual([])
    expect(result.current.hasFilter).toBe(false)
  })

  test('hasFilter is false when only rangeHours set (no sources)', () => {
    const { result } = renderHook(() => useSourceFilter(), { wrapper })
    act(() => {
      result.current.setFilter({ sourceIds: [], sourcePaths: [], rangeHours: 6, severities: [] })
    })
    expect(result.current.hasFilter).toBe(false)
  })

  test('hasFilter is true when sourcePaths is set', () => {
    const { result } = renderHook(() => useSourceFilter(), { wrapper })
    act(() => {
      result.current.setFilter({ sourceIds: [], sourcePaths: ['/var/log/syslog'], rangeHours: 24, severities: [] })
    })
    expect(result.current.hasFilter).toBe(true)
  })
})
