import React, { createContext, useContext } from 'react'

interface AuthCtx {
  me: { subject: string; scopes: string[] } | null
  logout: () => void
}

const Ctx = createContext<AuthCtx>({
  me: { subject: '', scopes: ['admin', 'read', 'write'] },
  logout: () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ me: { subject: '', scopes: ['admin', 'read', 'write'] }, logout: () => {} }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAuth() {
  return useContext(Ctx)
}
