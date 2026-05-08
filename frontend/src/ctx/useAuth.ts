import { useContext } from 'react'

import { AuthContext } from './AuthContext.shared'

export function useAuth() {
  return useContext(AuthContext)
}