import React, { createContext, useContext, useEffect, useState } from 'react'
import { loadStoredToken, setToken as _set, clearToken } from '../lib/api'
import { getMe } from '../lib/requests'

interface AuthCtx {
  token: string | null
  me: { subject: string; scopes: string[] } | null
  loading: boolean
  login: (t: string) => Promise<void>
  logout: () => void
}

const Ctx = createContext<AuthCtx>({} as AuthCtx)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const stored = loadStoredToken()
  const [token, setToken] = useState<string | null>(stored)
  const [me, setMe] = useState<AuthCtx['me']>(null)
  const [loading, setLoading] = useState<boolean>(!!stored)

  useEffect(() => {
    if (token) {
      setLoading(true)
      getMe()
        .then(setMe)
        .catch(() => {
          clearToken()
          setToken(null)
        })
        .finally(() => setLoading(false))
    } else {
      setMe(null)
      setLoading(false)
    }
  }, [token])

  async function login(t: string) {
    _set(t)
    setToken(t)
  }

  function logout() {
    clearToken()
    setToken(null)
  }

  return <Ctx.Provider value={{ token, me, loading, login, logout }}>{children}</Ctx.Provider>
}

export function useAuth() {
  return useContext(Ctx)
}
