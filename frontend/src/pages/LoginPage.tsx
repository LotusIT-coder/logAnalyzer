import { useState } from 'react'
import { useAuth } from '../ctx/AuthContext'

export default function LoginPage() {
  const { login } = useAuth()
  const [token, setToken] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    setLoading(true)
    try {
      await login(token.trim())
    } catch {
      setErr('Token ungültig oder Server nicht erreichbar.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <h1 style={styles.title}>Log Analyzer</h1>
        <form onSubmit={submit} style={styles.form}>
          <label style={styles.label}>API Token</label>
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="Bearer token..."
            style={styles.input}
            autoFocus
          />
          {err && <p style={styles.err}>{err}</p>}
          <button type="submit" disabled={loading || !token} style={styles.btn}>
            {loading ? 'Prüfe…' : 'Anmelden'}
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
  },
  err: { color: '#f87171', fontSize: '0.85rem', margin: 0 },
}
