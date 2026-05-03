import axios from 'axios'

export const api = axios.create({
  baseURL: '/api/v1',
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
  return '/api/v1'
}
