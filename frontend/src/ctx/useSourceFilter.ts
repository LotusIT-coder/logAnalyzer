import { useContext } from 'react'

import { SourceFilterContext } from './SourceFilterContext.shared'

export function useSourceFilter() {
  return useContext(SourceFilterContext)
}