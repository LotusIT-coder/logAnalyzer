import type { MeResponse } from '../lib/requests'

const ROLE_SCOPE_GRANTS: Record<NonNullable<MeResponse['role']>, string[]> = {
  viewer: ['read'],
  analyst: ['read', 'write'],
  operator: ['read', 'write'],
  admin: ['admin', 'read', 'write'],
}

function getEffectiveScopes(me: Pick<MeResponse, 'role' | 'scopes'> | null | undefined) {
  if (!me) return new Set<string>()
  return new Set([...(ROLE_SCOPE_GRANTS[me.role] ?? []), ...(me.scopes ?? [])])
}

export function hasScope(me: Pick<MeResponse, 'role' | 'scopes'> | null | undefined, scope: string) {
  const scopes = getEffectiveScopes(me)
  return scopes.has(scope) || scopes.has('admin')
}