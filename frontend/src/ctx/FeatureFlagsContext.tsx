import React, { useEffect, useState } from 'react'
import { getHealth } from '../lib/requests'
import { FeatureFlagsContext, type FeatureFlags } from './FeatureFlagsContext.shared'

export function FeatureFlagsProvider({ children }: { children: React.ReactNode }) {
  const [flags, setFlags] = useState<FeatureFlags>({
    ollama_available: false,
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      try {
        const health = await getHealth()
        setFlags({
          ollama_available: health.ollama_available ?? false,
        })
      } catch (err) {
        console.error('Failed to fetch feature flags:', err)
        setFlags({ ollama_available: false })
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  if (loading) {
    return <div style={{ display: 'none' }}>{children}</div>
  }

  return (
    <FeatureFlagsContext.Provider value={flags}>
      {children}
    </FeatureFlagsContext.Provider>
  )
}

export function useFeatureFlags() {
  return React.useContext(FeatureFlagsContext)
}
