/**
 * Global AI chat state – persists across tab navigation.
 * Pending jobs are polled every 2 s until completed/failed.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { aiChatAsync, getAIJob, type AIContextPayload } from '../lib/requests'
import { getApiErrorMessage } from '../lib/errors'
import { AIChatContext, type ChatMessage } from './AIChatContext.shared'
import { useSourceFilter } from './useSourceFilter'

const POLL_INTERVAL_MS = 2000

export function AIChatProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [model, setModel] = useState('')
  const [attachedContext, setAttachedContext] = useState<AIContextPayload | null>(null)
  const { filter: globalSourceFilter } = useSourceFilter()
  // Always-current ref so send() never reads stale filter from closure
  const sourceFilterRef = useRef(globalSourceFilter)
  const attachedContextRef = useRef<AIContextPayload | null>(attachedContext)
  useEffect(() => { sourceFilterRef.current = globalSourceFilter }, [globalSourceFilter])
  useEffect(() => { attachedContextRef.current = attachedContext }, [attachedContext])
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

  const send = useCallback(async (text: string, modelOverride?: string) => {
    const activeModel = modelOverride ?? model
    if (!text.trim() || !activeModel) return

    // Add user message
    setMessages(prev => [...prev, { role: 'user', content: text }])

    // Placeholder for assistant answer
    setMessages(prev => [...prev, { role: 'assistant' as const, content: '', pending: true }])

    // Submit async job
    try {
      const { job_id } = await aiChatAsync(activeModel, text, {
        ...sourceFilterRef.current,
        context: attachedContextRef.current,
      })
      // Find the placeholder index: it's the last pending message
      setMessages(prev => {
        const idx = prev.findLastIndex(m => m.pending && !m.jobId)
        if (idx < 0) return prev
        pendingJobs.current.set(job_id, idx)
        return prev.map((m, i) => i === idx ? { ...m, jobId: job_id } : m)
      })
    } catch (error: unknown) {
      setMessages(prev => {
        const idx = prev.findLastIndex(m => m.pending && !m.jobId)
        if (idx < 0) return prev
        return prev.map((m, i) =>
          i === idx
            ? { role: 'assistant', content: `Fehler: ${getApiErrorMessage(error)}`, pending: false, error: true }
            : m
        )
      })
    }
  }, [model])

  const clearMessages = useCallback(() => {
    pendingJobs.current.clear()
    setMessages([])
  }, [])

  const attachContext = useCallback((context: AIContextPayload | null) => {
    setAttachedContext(context)
  }, [])

  const clearAttachedContext = useCallback(() => {
    setAttachedContext(null)
  }, [])

  return (
    <AIChatContext.Provider value={{
      messages,
      model,
      setModel,
      pendingCount,
      send,
      clearMessages,
      attachedContext,
      attachContext,
      clearAttachedContext,
    }}>
      {children}
    </AIChatContext.Provider>
  )
}
