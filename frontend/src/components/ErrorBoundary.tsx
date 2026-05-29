import React from 'react'

interface ErrorBoundaryProps {
  children: React.ReactNode
  fallback?: React.ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * App-level error boundary. Catches render errors so a single broken page
 * does not crash the entire shell (navigation/header/footer stay usable
 * because the boundary lives inside the providers and outside the page).
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] render error:', error, info.componentStack)
  }

  handleReset = () => {
    this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children

    if (this.props.fallback) return this.props.fallback

    return (
      <div
        role="alert"
        style={{
          padding: '1.5rem',
          margin: '1.5rem',
          border: '1px solid var(--danger-fg)',
          borderRadius: 8,
          background: 'color-mix(in srgb, var(--danger-fg) 10%, var(--surface))',
          color: 'var(--fg)',
        }}
      >
        <h2 style={{ marginTop: 0, color: 'var(--danger-fg)' }}>Etwas ist schiefgelaufen.</h2>
        <p style={{ marginBottom: '0.75rem' }}>
          Die Ansicht konnte wegen eines unerwarteten Fehlers nicht angezeigt werden.
        </p>
        <pre
          style={{
            background: 'var(--surface-2)',
            padding: '0.75rem',
            borderRadius: 6,
            overflow: 'auto',
            fontSize: '0.8rem',
            maxHeight: 200,
          }}
        >
          {this.state.error.message}
        </pre>
        <button
          type="button"
          onClick={this.handleReset}
          style={{
            marginTop: '0.75rem',
            padding: '0.5rem 1rem',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--fg)',
            cursor: 'pointer',
          }}
        >
          Erneut versuchen
        </button>
      </div>
    )
  }
}

export default ErrorBoundary
