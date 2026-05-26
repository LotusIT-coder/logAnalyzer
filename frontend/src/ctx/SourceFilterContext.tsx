import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { EMPTY_FILTER, SourceFilterContext, type GlobalSourceFilter, type SourceOption } from './SourceFilterContext.shared'
import { getSources } from '../lib/requests'

const FILTER_STORAGE_KEY = 'logAnalyzer:globalSourceFilter'
const SELECTED_SOURCES_STORAGE_KEY = 'logAnalyzer:selectedSources'
const CUSTOM_SOURCES_STORAGE_KEY = 'logAnalyzer:customSources'

function readStoredJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function normalizeFilter(candidate: GlobalSourceFilter): GlobalSourceFilter {
  const manualFrom = typeof candidate.manualFrom === 'string' && candidate.manualFrom.trim().length > 0
    ? candidate.manualFrom
    : undefined
  const manualTo = typeof candidate.manualTo === 'string' && candidate.manualTo.trim().length > 0
    ? candidate.manualTo
    : undefined

  return {
    sourceIds: [...new Set(candidate.sourceIds ?? [])],
    sourcePaths: [...new Set(candidate.sourcePaths ?? [])],
    rangeHours: Number.isFinite(candidate.rangeHours) && candidate.rangeHours > 0 ? candidate.rangeHours : EMPTY_FILTER.rangeHours,
    severities: [...new Set((candidate.severities ?? []).map(level => String(level).toLowerCase()).filter(Boolean))],
    manualFrom,
    manualTo,
  }
}

function normalizeSelectedSource(source: SourceOption): SourceOption {
  if (source.id.startsWith('path:')) {
    const pathFromId = source.id.slice('path:'.length)
    return {
      ...source,
      kind: 'preset',
      path: source.path || pathFromId,
      id: `preset:${source.path || pathFromId}`,
    }
  }

  if ((source.kind === 'preset' || source.kind === 'custom') && !source.path && source.id.includes(':')) {
    const pathFromId = source.id.split(':').slice(1).join(':')
    const prefix = source.kind === 'preset' ? 'preset:' : 'custom:'
    return { ...source, path: pathFromId, id: `${prefix}${pathFromId}` }
  }

  if ((source.kind === 'preset' || source.kind === 'custom') && source.path) {
    const prefix = source.kind === 'preset' ? 'preset:' : 'custom:'
    return { ...source, id: `${prefix}${source.path}` }
  }
  return source
}

function normalizeSelectedSources(candidates: SourceOption[]): SourceOption[] {
  const seen = new Set<string>()
  const normalized: SourceOption[] = []
  for (const candidate of candidates ?? []) {
    const source = normalizeSelectedSource(candidate)
    if (seen.has(source.id)) continue
    seen.add(source.id)
    normalized.push(source)
  }
  return normalized
}

export function SourceFilterProvider({ children }: { children: React.ReactNode }) {
  const [filter, setFilterState] = useState<GlobalSourceFilter>(() => normalizeFilter(readStoredJson(FILTER_STORAGE_KEY, EMPTY_FILTER)))
  const [selectedSources, setSelectedSources] = useState<SourceOption[]>(() => normalizeSelectedSources(readStoredJson(SELECTED_SOURCES_STORAGE_KEY, [])))
  const [customSources, setCustomSources] = useState<SourceOption[]>(() => readStoredJson(CUSTOM_SOURCES_STORAGE_KEY, []))

  const setFilter = useCallback((next: GlobalSourceFilter) => {
    setFilterState(normalizeFilter(next))
  }, [])

  const clearFilter = useCallback(() => {
    setFilterState(EMPTY_FILTER)
    setSelectedSources([])
    setCustomSources([])
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filter))
  }, [filter])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(SELECTED_SOURCES_STORAGE_KEY, JSON.stringify(selectedSources))
  }, [selectedSources])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(CUSTOM_SOURCES_STORAGE_KEY, JSON.stringify(customSources))
  }, [customSources])

  useEffect(() => {
    const hasActiveFilter = filter.sourceIds.length > 0 || filter.sourcePaths.length > 0
    if (!hasActiveFilter && selectedSources.length > 0) {
      setSelectedSources([])
    }
  }, [filter.sourceIds, filter.sourcePaths, selectedSources.length])

  // Reconcile stored selection against the actual available sources on the
  // backend. Removes IDs that no longer exist (e.g. after a source was deleted
  // outside this browser session) so the dropdown does not display ghost
  // entries forever.
  const { data: availableSources } = useQuery({
    queryKey: ['sources', 'reconcile'],
    queryFn: getSources,
    staleTime: 60_000,
    retry: 1,
  })

  useEffect(() => {
    if (!availableSources) return
    const validIds = new Set(availableSources.map(s => s.id))

    const prunedFilterIds = filter.sourceIds.filter(id => validIds.has(id))
    if (prunedFilterIds.length !== filter.sourceIds.length) {
      setFilterState(prev => ({ ...prev, sourceIds: prunedFilterIds }))
    }

    const prunedSelected = selectedSources.filter(source => {
      if (source.kind !== 'configured') return true
      const rawId = source.id.startsWith('source:') ? source.id.slice('source:'.length) : source.id
      return validIds.has(rawId)
    })
    if (prunedSelected.length !== selectedSources.length) {
      setSelectedSources(prunedSelected)
    }
  }, [availableSources, filter.sourceIds, selectedSources])

  const hasFilter = filter.sourceIds.length > 0 || filter.sourcePaths.length > 0

  const value = useMemo(
    () => ({ filter, setFilter, clearFilter, hasFilter, selectedSources, setSelectedSources, customSources, setCustomSources }),
    [clearFilter, customSources, filter, hasFilter, selectedSources, setFilter],
  )

  return <SourceFilterContext.Provider value={value}>{children}</SourceFilterContext.Provider>
}
