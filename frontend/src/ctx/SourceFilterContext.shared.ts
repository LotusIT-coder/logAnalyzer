import { createContext } from 'react'

export interface SourceOption {
  id: string
  label: string
  path: string
  kind: 'preset' | 'configured' | 'custom'
}

export interface GlobalSourceFilter {
  sourceIds: string[]
  sourcePaths: string[]
  rangeHours: number
  severities: string[]
  manualFrom?: string
  manualTo?: string
}

export interface SourceFilterCtx {
  filter: GlobalSourceFilter
  setFilter: (next: GlobalSourceFilter) => void
  clearFilter: () => void
  hasFilter: boolean
  selectedSources: SourceOption[]
  setSelectedSources: (value: SourceOption[] | ((prev: SourceOption[]) => SourceOption[])) => void
  customSources: SourceOption[]
  setCustomSources: (value: SourceOption[] | ((prev: SourceOption[]) => SourceOption[])) => void
}

export const EMPTY_FILTER: GlobalSourceFilter = { sourceIds: [], sourcePaths: [], rangeHours: 24, severities: [] }

export const SourceFilterContext = createContext<SourceFilterCtx>({
  filter: EMPTY_FILTER,
  setFilter: () => undefined,
  clearFilter: () => undefined,
  hasFilter: false,
  selectedSources: [],
  setSelectedSources: () => undefined,
  customSources: [],
  setCustomSources: () => undefined,
})