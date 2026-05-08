import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { useAuth } from '../ctx/useAuth'

export default function LoginPage() {
  const { login, isLoading } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')

    try {
      await login(email.trim(), password)
      navigate('/', { replace: true })
    } catch {
      setError('Anmeldung fehlgeschlagen.')
    }
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <h1 style={styles.title}>Log Analyzer</h1>
        <form onSubmit={handleSubmit} style={styles.form}>
          <label style={styles.label} htmlFor="login-email">E-Mail</label>
          <input
            id="login-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            style={styles.input}
            placeholder="admin@example.com"
            autoComplete="email"
          />
          <label style={styles.label} htmlFor="login-password">Passwort</label>
          <input
            id="login-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            style={styles.input}
            placeholder="••••••••"
            autoComplete="current-password"
          />
          {error && <p style={styles.err}>{error}</p>}
          <button disabled={isLoading || !email.trim() || !password} type="submit" style={styles.btn}>
            {isLoading ? 'Pruefe...' : 'Anmelden'}
          </button>
        </form>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: '100vh', background: '#0f172a',
  },
  card: {
    background: '#1e293b', borderRadius: 12, padding: '2.5rem 3rem',
    width: 360, boxShadow: '0 4px 32px #0008',
  },
  title: { color: '#f1f5f9', fontSize: '1.5rem', marginBottom: '2rem', textAlign: 'center' },
  form: { display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  label: { color: '#94a3b8', fontSize: '0.85rem' },
  input: {
    padding: '0.65rem 0.85rem', borderRadius: 6, border: '1px solid #334155',
    background: '#0f172a', color: '#f1f5f9', fontSize: '1rem', outline: 'none',
  },
  btn: {
    marginTop: '0.5rem', padding: '0.7rem', borderRadius: 6,
    background: '#3b82f6', color: '#fff', border: 'none',
    cursor: 'pointer', fontSize: '1rem', fontWeight: 600,
    opacity: 1,
  },
  err: { color: '#f87171', fontSize: '0.85rem', margin: 0 },
}
