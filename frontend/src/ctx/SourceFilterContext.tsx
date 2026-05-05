import React, { createContext, useContext, useMemo, useState } from 'react'

export interface SourceOption {
  id: string       // 'preset:<path>' | 'source:<uuid>' | 'custom:<path>'
  label: string
  path: string
  kind: 'preset' | 'configured' | 'custom'
}

export interface GlobalSourceFilter {
  sourceIds: string[]
  sourcePaths: string[]
  rangeHours: number
}

interface SourceFilterCtx {
  filter: GlobalSourceFilter
  setFilter: (next: GlobalSourceFilter) => void
  clearFilter: () => void
  hasFilter: boolean
  selectedSources: SourceOption[]
  setSelectedSources: (v: SourceOption[] | ((prev: SourceOption[]) => SourceOption[])) => void
  customSources: SourceOption[]
  setCustomSources: (v: SourceOption[] | ((prev: SourceOption[]) => SourceOption[])) => void
}

const EMPTY_FILTER: GlobalSourceFilter = { sourceIds: [], sourcePaths: [], rangeHours: 0 }

const Ctx = createContext<SourceFilterCtx>({
  filter: EMPTY_FILTER,
  setFilter: () => {},
  clearFilter: () => {},
  hasFilter: false,
  selectedSources: [],
  setSelectedSources: () => {},
  customSources: [],
  setCustomSources: () => {},
})

export function SourceFilterProvider({ children }: { children: React.ReactNode }) {
  const [filter, setFilterState] = useState<GlobalSourceFilter>(EMPTY_FILTER)
  const [selectedSources, setSelectedSources] = useState<SourceOption[]>([])
  const [customSources, setCustomSources] = useState<SourceOption[]>([])

  function setFilter(next: GlobalSourceFilter) {
    setFilterState({
      sourceIds: [...new Set(next.sourceIds)],
      sourcePaths: [...new Set(next.sourcePaths)],
      rangeHours: next.rangeHours,
    })
  }

  function clearFilter() {
    setFilterState(EMPTY_FILTER)
    setSelectedSources([])
    setCustomSources([])
  }

  const hasFilter = filter.sourceIds.length > 0 || filter.sourcePaths.length > 0

  const value = useMemo(
    () => ({ filter, setFilter, clearFilter, hasFilter, selectedSources, setSelectedSources, customSources, setCustomSources }),
    [filter, hasFilter, selectedSources, customSources],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSourceFilter() {
  return useContext(Ctx)
}
