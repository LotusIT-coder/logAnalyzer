import { createContext } from 'react'

import type { AIContextPayload } from '../lib/requests'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  references?: string[]
  pending?: boolean
  jobId?: string
  error?: boolean
}

export interface AIChatCtx {
  messages: ChatMessage[]
  model: string
  setModel: (model: string) => void
  pendingCount: number
  send: (text: string, modelOverride?: string) => Promise<void>
  clearMessages: () => void
  attachedContext: AIContextPayload | null
  attachContext: (context: AIContextPayload | null) => void
  clearAttachedContext: () => void
}

export const AIChatContext = createContext<AIChatCtx>({
  messages: [],
  model: '',
  setModel: () => undefined,
  pendingCount: 0,
  send: async () => undefined,
  clearMessages: () => undefined,
  attachedContext: null,
  attachContext: () => undefined,
  clearAttachedContext: () => undefined,
})