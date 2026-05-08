import { createContext } from 'react'

import type { MeResponse } from '../lib/requests'

export interface AuthCtx {
  me: MeResponse | null
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => void
}

const DEFAULT_AUTH: AuthCtx = {
  me: null,
  isLoading: false,
  login: async () => undefined,
  logout: () => undefined,
}

export const AuthContext = createContext<AuthCtx>(DEFAULT_AUTH)