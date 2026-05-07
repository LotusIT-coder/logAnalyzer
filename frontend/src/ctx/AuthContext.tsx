import React, { createContext, useContext, useEffect, useState } from 'react'

import { clearToken, loadStoredToken, setToken } from '../lib/api'
import { getMe, loginWithPassword, type MeResponse } from '../lib/requests'

const ROLE_SCOPE_GRANTS: Record<NonNullable<MeResponse['role']>, string[]> = {
  viewer: ['read'],
  analyst: ['read', 'write'],
  operator: ['read', 'write'],
  admin: ['admin', 'read', 'write'],
}

export interface AuthCtx {
  me: MeResponse | null
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => void
}

const DEFAULT_AUTH: AuthCtx = {
  me: null,
  isLoading: false,
  login: async () => {},
  logout: () => {},
}

const Ctx = createContext<AuthCtx>(DEFAULT_AUTH)

function isSessionInvalidError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  if (!('response' in error)) return false

  const response = (error as { response?: { status?: number } }).response
  return response?.status === 401 || response?.status === 403
}

export function getEffectiveScopes(me: Pick<MeResponse, 'role' | 'scopes'> | null | undefined) {
  if (!me) return new Set<string>()
  return new Set([...(ROLE_SCOPE_GRANTS[me.role] ?? []), ...(me.scopes ?? [])])
}

export function hasScope(me: Pick<MeResponse, 'role' | 'scopes'> | null | undefined, scope: string) {
  const scopes = getEffectiveScopes(me)
  return scopes.has(scope) || scopes.has('admin')
}

export function AuthProvider({ children, value }: { children: React.ReactNode; value?: Partial<AuthCtx> }) {
  const [me, setMe] = useState<MeResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (value) return

    let active = true
    let retryTimer: number | undefined

    async function bootstrap() {
      const storedToken = loadStoredToken()

      if (!storedToken) {
        if (active) setIsLoading(false)
        return
      }

      try {
        const currentUser = await getMe()
        if (active) setMe(currentUser)
      } catch (error) {
        if (isSessionInvalidError(error)) {
          clearToken()
          if (active) {
            setMe(null)
            setIsLoading(false)
          }
          return
        }

        if (active) {
          retryTimer = window.setTimeout(() => {
            void bootstrap()
          }, 1500)
        }
        return
      }

      if (active) setIsLoading(false)
    }

    void bootstrap()

    return () => {
      active = false
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [value])

  async function login(email: string, password: string) {
    setIsLoading(true)

    try {
      const auth = await loginWithPassword({ email, password })
      setToken(auth.token)
      const currentUser = await getMe()
      setMe(currentUser)
    } catch (error) {
      clearToken()
      setMe(null)
      throw error
    } finally {
      setIsLoading(false)
    }
  }

  function logout() {
    clearToken()
    setMe(null)
    setIsLoading(false)
  }

  const resolvedValue: AuthCtx = value
    ? {
        me: value.me ?? me,
        isLoading: value.isLoading ?? isLoading,
        login: value.login ?? login,
        logout: value.logout ?? logout,
      }
    : {
        me,
        isLoading,
        login,
        logout,
      }

  return (
    <Ctx.Provider value={resolvedValue}>
      {children}
    </Ctx.Provider>
  )
}

export function useAuth() {
  return useContext(Ctx)
}
