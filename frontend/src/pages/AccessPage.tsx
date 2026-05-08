import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { useAuth } from '../ctx/useAuth'
import { getApiErrorMessage } from '../lib/errors'
import {
  createToken,
  createUser,
  getTokens,
  getUsers,
  revokeToken,
  type TokenRole,
} from '../lib/requests'

const ROLE_OPTIONS: TokenRole[] = ['viewer', 'analyst', 'operator', 'admin']

function isAdmin(role?: TokenRole, scopes?: string[]) {
  return role === 'admin' || scopes?.includes('admin')
}

export default function AccessPage() {
  const { me } = useAuth()
  const queryClient = useQueryClient()
  const [userName, setUserName] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [userPassword, setUserPassword] = useState('')
  const [userRole, setUserRole] = useState<TokenRole>('viewer')
  const [tokenName, setTokenName] = useState('')
  const [tokenRole, setTokenRole] = useState<TokenRole>('viewer')
  const [selectedUserId, setSelectedUserId] = useState('')
  const [latestToken, setLatestToken] = useState('')
  const [userBusy, setUserBusy] = useState(false)
  const [tokenBusy, setTokenBusy] = useState(false)
  const [revokeBusyId, setRevokeBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const usersQuery = useQuery({
    queryKey: ['auth', 'users'],
    queryFn: getUsers,
    enabled: isAdmin(me?.role, me?.scopes),
  })
  const tokensQuery = useQuery({
    queryKey: ['auth', 'tokens'],
    queryFn: getTokens,
    enabled: isAdmin(me?.role, me?.scopes),
  })

  const users = useMemo(() => usersQuery.data?.items ?? [], [usersQuery.data?.items])
  const tokens = useMemo(() => tokensQuery.data?.items ?? [], [tokensQuery.data?.items])
  const userNames = useMemo(
    () => new Map(users.map(user => [user.id, user.name])),
    [users],
  )

  if (!isAdmin(me?.role, me?.scopes)) {
    return <div style={styles.notice}>Dieser Bereich ist nur fuer Administratoren sichtbar.</div>
  }

  async function handleCreateUser() {
    setUserBusy(true)
    setError('')
    try {
      await createUser({
        name: userName,
        email: userEmail,
        password: userPassword,
        role: userRole,
        enabled: true,
      })
      setUserName('')
      setUserEmail('')
      setUserPassword('')
      setUserRole('viewer')
      await queryClient.invalidateQueries({ queryKey: ['auth', 'users'] })
    } catch (requestError: unknown) {
      setError(getApiErrorMessage(requestError, 'Benutzer konnte nicht angelegt werden.'))
    } finally {
      setUserBusy(false)
    }
  }

  async function handleCreateToken() {
    setTokenBusy(true)
    setError('')
    try {
      const payload = {
        name: tokenName,
        role: tokenRole,
        ...(selectedUserId ? { user_id: selectedUserId } : {}),
      }
      const result = await createToken(payload)
      setLatestToken(result.token)
      setTokenName('')
      setTokenRole('viewer')
      setSelectedUserId('')
      await queryClient.invalidateQueries({ queryKey: ['auth', 'tokens'] })
    } catch (requestError: unknown) {
      setError(getApiErrorMessage(requestError, 'Token konnte nicht erzeugt werden.'))
    } finally {
      setTokenBusy(false)
    }
  }

  async function handleRevokeToken(tokenId: string) {
    setRevokeBusyId(tokenId)
    setError('')
    try {
      await revokeToken(tokenId)
      await queryClient.invalidateQueries({ queryKey: ['auth', 'tokens'] })
    } catch (requestError: unknown) {
      setError(getApiErrorMessage(requestError, 'Token konnte nicht widerrufen werden.'))
    } finally {
      setRevokeBusyId(null)
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>Zugriff und Benutzer</h2>
          <p style={styles.subtitle}>Benutzer anlegen, Rollen vergeben und API-Tokens verwalten.</p>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}
      {latestToken && (
        <div style={styles.tokenCallout}>
          <div style={styles.tokenCalloutLabel}>Neues Token</div>
          <div style={styles.tokenValue}>{latestToken}</div>
        </div>
      )}

      <div style={styles.grid}>
        <section style={styles.panel}>
          <h3 style={styles.sectionTitle}>Benutzer anlegen</h3>
          <p style={styles.hint}>
            Neue Benutzer erhalten ihren festen persoenlichen Token ueber den normalen Passwort-Login.
          </p>
          <div style={styles.formGrid}>
            <label style={styles.field}>
              <span style={styles.label}>Benutzername</span>
              <input value={userName} onChange={event => setUserName(event.target.value)} style={styles.input} />
            </label>
            <label style={styles.field}>
              <span style={styles.label}>E-Mail</span>
              <input value={userEmail} onChange={event => setUserEmail(event.target.value)} style={styles.input} />
            </label>
            <label style={styles.field}>
              <span style={styles.label}>Initiales Passwort</span>
              <input type="password" value={userPassword} onChange={event => setUserPassword(event.target.value)} style={styles.input} />
            </label>
            <label style={styles.field}>
              <span style={styles.label}>Benutzerrolle</span>
              <select value={userRole} onChange={event => setUserRole(event.target.value as TokenRole)} style={styles.select}>
                {ROLE_OPTIONS.map(role => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </select>
            </label>
          </div>
          <button
            onClick={handleCreateUser}
            disabled={userBusy || !userName || !userEmail || !userPassword}
            style={styles.primaryButton}
          >
            {userBusy ? 'Speichere...' : 'Benutzer anlegen'}
          </button>

          <div style={styles.listSection}>
            <h3 style={styles.sectionTitle}>Benutzer</h3>
            {usersQuery.isLoading ? (
              <div style={styles.muted}>Lade Benutzer...</div>
            ) : users.length ? (
              <div style={styles.stack}>
                {users.map(user => (
                  <div key={user.id} style={styles.rowCard}>
                    <div>
                      <div style={styles.rowTitle}>{user.name}</div>
                      <div style={styles.rowMeta}>{user.email}</div>
                    </div>
                    <div style={styles.badge}>{user.role}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={styles.muted}>Noch keine Benutzer vorhanden.</div>
            )}
          </div>
        </section>

        <section style={styles.panel}>
          <h3 style={styles.sectionTitle}>Token erzeugen oder neu zuweisen</h3>
          <p style={styles.hint}>
            Wenn ein Benutzer ausgewaehlt ist, ersetzt ein neuer Token den bisherigen aktiven Benutzer-Token.
          </p>
          <div style={styles.formGrid}>
            <label style={styles.field}>
              <span style={styles.label}>Token-Name</span>
              <input value={tokenName} onChange={event => setTokenName(event.target.value)} style={styles.input} />
            </label>
            <label style={styles.field}>
              <span style={styles.label}>Token-Rolle</span>
              <select value={tokenRole} onChange={event => setTokenRole(event.target.value as TokenRole)} style={styles.select}>
                {ROLE_OPTIONS.map(role => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </select>
            </label>
            <label style={styles.field}>
              <span style={styles.label}>Zugeordneter Benutzer</span>
              <select value={selectedUserId} onChange={event => setSelectedUserId(event.target.value)} style={styles.select}>
                <option value="">Keiner</option>
                {users.map(user => (
                  <option key={user.id} value={user.id}>{user.name}</option>
                ))}
              </select>
            </label>
          </div>
          <button
            onClick={handleCreateToken}
            disabled={tokenBusy || !tokenName}
            style={styles.primaryButton}
          >
            {tokenBusy ? 'Erzeuge...' : 'Token erzeugen'}
          </button>

          <div style={styles.listSection}>
            <h3 style={styles.sectionTitle}>Ausgegebene Tokens</h3>
            {tokensQuery.isLoading ? (
              <div style={styles.muted}>Lade Tokens...</div>
            ) : tokens.length ? (
              <div style={styles.stack}>
                {tokens.map(token => (
                  <div key={token.id} style={styles.rowCard}>
                    <div>
                      <div style={styles.rowTitle}>{token.name}</div>
                      <div style={styles.rowMeta}>
                        {token.user_id ? userNames.get(token.user_id) ?? token.user_id : 'Kein Benutzer'}
                      </div>
                    </div>
                    <div style={styles.rowActions}>
                      <div style={styles.badge}>{token.role}</div>
                      <button
                        onClick={() => handleRevokeToken(token.id)}
                        disabled={token.revoked_at !== null && token.revoked_at !== undefined || revokeBusyId === token.id}
                        style={styles.secondaryButton}
                      >
                        {token.revoked_at ? 'Widerrufen' : revokeBusyId === token.id ? 'Widerrufe...' : 'Token widerrufen'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={styles.muted}>Noch keine Tokens vorhanden.</div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: { display: 'flex', flexDirection: 'column', gap: '1.25rem' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  title: { margin: 0, fontSize: '1.6rem' },
  subtitle: { margin: '0.35rem 0 0 0', color: '#94a3b8' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1rem' },
  panel: { background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: '1.25rem' },
  sectionTitle: { margin: '0 0 1rem 0', fontSize: '1rem' },
  hint: { margin: '0 0 1rem 0', color: '#94a3b8', fontSize: '0.88rem', lineHeight: 1.5 },
  formGrid: { display: 'grid', gap: '0.85rem', marginBottom: '1rem' },
  field: { display: 'flex', flexDirection: 'column', gap: '0.35rem' },
  label: { color: '#94a3b8', fontSize: '0.82rem' },
  input: { background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 8, padding: '0.65rem 0.8rem' },
  select: { background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 8, padding: '0.65rem 0.8rem' },
  primaryButton: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '0.65rem 1rem', fontWeight: 600, cursor: 'pointer' },
  secondaryButton: { background: 'transparent', color: '#fca5a5', border: '1px solid #7f1d1d', borderRadius: 8, padding: '0.5rem 0.8rem', cursor: 'pointer' },
  listSection: { marginTop: '1.25rem' },
  stack: { display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  rowCard: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', background: '#0f172a', border: '1px solid #334155', borderRadius: 10, padding: '0.9rem 1rem' },
  rowTitle: { fontWeight: 600 },
  rowMeta: { color: '#94a3b8', fontSize: '0.84rem', marginTop: '0.2rem' },
  rowActions: { display: 'flex', alignItems: 'center', gap: '0.75rem' },
  badge: { background: '#1e3a5f', color: '#93c5fd', borderRadius: 999, padding: '0.2rem 0.6rem', fontSize: '0.75rem', fontWeight: 700 },
  muted: { color: '#64748b' },
  error: { background: '#3f1d1d', color: '#fecaca', border: '1px solid #7f1d1d', borderRadius: 10, padding: '0.8rem 1rem' },
  notice: { background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: '1rem 1.25rem', color: '#cbd5e1' },
  tokenCallout: { background: '#10223f', border: '1px solid #1d4ed8', borderRadius: 12, padding: '1rem 1.1rem' },
  tokenCalloutLabel: { color: '#93c5fd', fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.4rem' },
  tokenValue: { fontFamily: 'monospace', wordBreak: 'break-all' },
}