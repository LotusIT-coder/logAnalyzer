import React, { useCallback, useMemo, useState } from 'react'

import { EMPTY_FILTER, SourceFilterContext, type GlobalSourceFilter, type SourceOption } from './SourceFilterContext.shared'

export function SourceFilterProvider({ children }: { children: React.ReactNode }) {
  const [filter, setFilterState] = useState<GlobalSourceFilter>(EMPTY_FILTER)
  const [selectedSources, setSelectedSources] = useState<SourceOption[]>([])
  const [customSources, setCustomSources] = useState<SourceOption[]>([])

  const setFilter = useCallback((next: GlobalSourceFilter) => {
    setFilterState({
      sourceIds: [...new Set(next.sourceIds)],
      sourcePaths: [...new Set(next.sourcePaths)],
      rangeHours: next.rangeHours,
    })
  }, [])

  const clearFilter = useCallback(() => {
    setFilterState(EMPTY_FILTER)
    setSelectedSources([])
    setCustomSources([])
  }, [])

  const hasFilter = filter.sourceIds.length > 0 || filter.sourcePaths.length > 0

  const value = useMemo(
    () => ({ filter, setFilter, clearFilter, hasFilter, selectedSources, setSelectedSources, customSources, setCustomSources }),
    [clearFilter, customSources, filter, hasFilter, selectedSources, setFilter],
  )

  return <SourceFilterContext.Provider value={value}>{children}</SourceFilterContext.Provider>
}
