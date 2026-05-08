import axios from 'axios'

function resolveApiBase() {
  const configuredBase = import.meta.env.VITE_API_BASE_URL?.trim()
  if (!configuredBase) return '/api/v1'

  const normalizedBase = configuredBase.replace(/\/$/, '')
  return normalizedBase.endsWith('/api/v1') ? normalizedBase : `${normalizedBase}/api/v1`
}

const API_BASE = resolveApiBase()

export const api = axios.create({
  baseURL: API_BASE,
})

/** Base URL for direct (non-axios) requests like EventSource */
export function getApiBase() {
  return API_BASE
}
