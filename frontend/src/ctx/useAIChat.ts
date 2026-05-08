import { useContext } from 'react'

import { AIChatContext } from './AIChatContext.shared'

export function useAIChat() {
  return useContext(AIChatContext)
}