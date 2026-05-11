import React from 'react'

export interface FeatureFlags {
  ollama_available: boolean
}

export const FeatureFlagsContext = React.createContext<FeatureFlags>({
  ollama_available: false,
})
