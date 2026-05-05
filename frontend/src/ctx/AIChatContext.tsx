/**
 * Global AI chat state – persists across tab navigation.
 * Pending jobs are polled every 2 s until completed/failed.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { aiChatAsync, getAIJob } from '../lib/requests'
import { useSourceFilter } from './SourceFilterContext'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  references?: string[]
  pending?: boolean   // true while job is in-flight
  jobId?: string
  error?: boolean
}

interface AIChatCtx {
  messages: ChatMessage[]
  model: string
  setModel: (m: string) => void
  pendingCount: number
  send: (text: string) => Promise<void>
  clearMessages: () => void
}

const Ctx = createContext<AIChatCtx>({} as AIChatCtx)

const POLL_INTERVAL_MS = 2000

function extractErrorMessage(err: any): string {
  const detail = err?.response?.data?.detail
  const message = err?.response?.data?.message
  const own = err?.message
  const candidate = [detail, message, own].find(v => typeof v === 'string' && v.trim().length > 0)
  return candidate ?? 'Unbekannter Fehler'
}

export function AIChatProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [model, setModel] = useState('')
  const { filter: globalSourceFilter } = useSourceFilter()
  // Always-current ref so send() never reads stale filter from closure
  const sourceFilterRef = useRef(globalSourceFilter)
  useEffect(() => { sourceFilterRef.current = globalSourceFilter }, [globalSourceFilter])
  // jobId -> message index mapping for polling
  const pendingJobs = useRef<Map<string, number>>(new Map())
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const pendingCount = messages.filter(m => m.pending).length

  // Poll all pending jobs
  const pollJobs = useCallback(async () => {
    const entries = Array.from(pendingJobs.current.entries())
    if (entries.length === 0) return

    await Promise.all(entries.map(async ([jobId, idx]) => {
      try {
        const job = await getAIJob(jobId)
        if (job.status === 'completed' && job.result) {
          pendingJobs.current.delete(jobId)
          setMessages(prev => prev.map((m, i) =>
            i === idx
              ? { role: 'assistant', content: job.result!.answer, references: job.result!.references, pending: false }
              : m
          ))
        } else if (job.status === 'failed') {
          pendingJobs.current.delete(jobId)
          setMessages(prev => prev.map((m, i) =>
            i === idx
              ? { role: 'assistant', content: `Fehler: ${(job.error ?? '').trim() || 'Unbekannter Fehler'}`, pending: false, error: true }
              : m
          ))
        }
      } catch {
        // network hiccup – try again next tick
      }
    }))
  }, [])

  // Start/stop polling based on pending jobs
  useEffect(() => {
    if (pendingCount > 0 && !pollTimer.current) {
      pollTimer.current = setInterval(pollJobs, POLL_INTERVAL_MS)
    } else if (pendingCount === 0 && pollTimer.current) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
    return () => {
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null }
    }
  }, [pendingCount, pollJobs])

  const send = useCallback(async (text: string) => {
    if (!text.trim() || !model) return

    // Add user message
    setMessages(prev => [...prev, { role: 'user', content: text }])

    // Placeholder for assistant answer
    setMessages(prev => [...prev, { role: 'assistant' as const, content: '', pending: true }])

    // Submit async job
    try {
      const { job_id } = await aiChatAsync(model, text, sourceFilterRef.current)
      // Find the placeholder index: it's the last pending message
      setMessages(prev => {
        const idx = prev.findLastIndex(m => m.pending && !m.jobId)
        if (idx < 0) return prev
        pendingJobs.current.set(job_id, idx)
        return prev.map((m, i) => i === idx ? { ...m, jobId: job_id } : m)
      })
    } catch (e: any) {
      setMessages(prev => {
        const idx = prev.findLastIndex(m => m.pending && !m.jobId)
        if (idx < 0) return prev
        return prev.map((m, i) =>
          i === idx
            ? { role: 'assistant', content: `Fehler: ${extractErrorMessage(e)}`, pending: false, error: true }
            : m
        )
      })
    }
  }, [model, messages.length])

  const clearMessages = useCallback(() => {
    pendingJobs.current.clear()
    setMessages([])
  }, [])

  return (
    <Ctx.Provider value={{ messages, model, setModel, pendingCount, send, clearMessages }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAIChat() {
  return useContext(Ctx)
}
