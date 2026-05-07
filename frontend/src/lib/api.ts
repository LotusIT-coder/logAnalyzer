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

export function setToken(token: string) {
  api.defaults.headers.common['Authorization'] = `Bearer ${token}`
  localStorage.setItem('api_token', token)
}

export function clearToken() {
  delete api.defaults.headers.common['Authorization']
  localStorage.removeItem('api_token')
}

export function loadStoredToken() {
  const t = localStorage.getItem('api_token')
  if (t) api.defaults.headers.common['Authorization'] = `Bearer ${t}`
  return t
}

export function getStoredToken() {
  return localStorage.getItem('api_token')
}

/** Base URL for direct (non-axios) requests like EventSource */
export function getApiBase() {
  return API_BASE
}
