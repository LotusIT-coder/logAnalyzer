import React from 'react'

const ANSI_SGR_REGEX = /(?:\u001b\[|\x1b\[|\[)(\d+(?:;\d+)*)m/g

interface AnsiSegment {
  text: string
  style: React.CSSProperties
}

function hasAnsiSgr(text: string): boolean {
  return /(?:\u001b\[|\x1b\[|\[)\d+(?:;\d+)*m/.test(text)
}

function applySgrCodes(current: React.CSSProperties, codeGroup: string): React.CSSProperties {
  const next: React.CSSProperties = { ...current }
  const codes = codeGroup.split(';').map(value => Number(value)).filter(Number.isFinite)
  const normalized = codes.length > 0 ? codes : [0]

  for (const code of normalized) {
    if (code === 0) {
      delete next.color
      delete next.backgroundColor
      delete next.fontWeight
      delete next.opacity
    } else if (code === 1) {
      next.fontWeight = 700
    } else if (code === 2) {
      next.opacity = 0.72
    } else if (code === 22) {
      delete next.fontWeight
      delete next.opacity
    } else if (code === 39) {
      delete next.color
    } else if (code === 49) {
      delete next.backgroundColor
    } else {
      const fgMap: Record<number, string> = {
        30: 'var(--ansi-fg-30)', 31: 'var(--ansi-fg-31)', 32: 'var(--ansi-fg-32)', 33: 'var(--ansi-fg-33)',
        34: 'var(--ansi-fg-34)', 35: 'var(--ansi-fg-35)', 36: 'var(--ansi-fg-36)', 37: 'var(--ansi-fg-37)',
        90: 'var(--ansi-fg-90)', 91: 'var(--ansi-fg-91)', 92: 'var(--ansi-fg-92)', 93: 'var(--ansi-fg-93)',
        94: 'var(--ansi-fg-94)', 95: 'var(--ansi-fg-95)', 96: 'var(--ansi-fg-96)', 97: 'var(--ansi-fg-97)',
      }
      const bgMap: Record<number, string> = {
        40: 'var(--ansi-bg-40)', 41: 'var(--ansi-bg-41)', 42: 'var(--ansi-bg-42)', 43: 'var(--ansi-bg-43)',
        44: 'var(--ansi-bg-44)', 45: 'var(--ansi-bg-45)', 46: 'var(--ansi-bg-46)', 47: 'var(--ansi-bg-47)',
        100: 'var(--ansi-bg-100)', 101: 'var(--ansi-bg-101)', 102: 'var(--ansi-bg-102)', 103: 'var(--ansi-bg-103)',
        104: 'var(--ansi-bg-104)', 105: 'var(--ansi-bg-105)', 106: 'var(--ansi-bg-106)', 107: 'var(--ansi-bg-107)',
      }
      if (fgMap[code]) next.color = fgMap[code]
      if (bgMap[code]) next.backgroundColor = bgMap[code]
    }
  }

  return next
}

function splitAnsiSegments(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = []
  let activeStyle: React.CSSProperties = {}
  let cursor = 0
  let match: RegExpExecArray | null

  ANSI_SGR_REGEX.lastIndex = 0
  while ((match = ANSI_SGR_REGEX.exec(text)) !== null) {
    const [token, codes] = match
    const index = match.index

    if (index > cursor) {
      segments.push({ text: text.slice(cursor, index), style: { ...activeStyle } })
    }

    activeStyle = applySgrCodes(activeStyle, codes)
    cursor = index + token.length
  }

  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), style: { ...activeStyle } })
  }

  if (segments.length === 0) {
    segments.push({ text, style: {} })
  }

  return segments
}

export function AnsiText({ message, inline = false }: { message: string; inline?: boolean }) {
  const segments = splitAnsiSegments(message)
  const content = segments.map((segment, index) => (
    <span key={`${index}-${segment.text.length}`} style={segment.style}>{segment.text}</span>
  ))

  if (inline) {
    return (
      <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {content}
      </span>
    )
  }

  return (
    <pre style={{
      margin: 0,
      padding: '0.5rem',
      background: 'var(--surface)',
      borderRadius: 6,
      color: 'var(--fg)',
      fontFamily: 'monospace',
      fontSize: '0.78rem',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
    }}>
      {content}
    </pre>
  )
}

/**
 * Field type categorization for intelligent color coding
 */
function getFieldColor(key: string, value: string): string {
  const keyLower = key.toLowerCase()
  const valueLower = value.toLowerCase()
  
  // Error/Critical fields (Red)
  if (/error|exception|fatal|critical|status|fail/i.test(keyLower)) {
    if (/error|exception|fatal|500|fail|denied|permission/i.test(valueLower)) {
      return '#ef4444' // red
    }
  }
  
  // Warnings (Orange)
  if (/warn|deprecated|skip|timeout|retry|backoff/i.test(keyLower)) {
    return '#f97316' // orange
  }
  
  // Success/Threat indicators (Green)
  if (/threat_detected|success|created|completed|found|detected|recovered/i.test(keyLower)) {
    if (/true|yes|detected|found|recovered|created/i.test(valueLower)) {
      return '#22c55e' // green
    }
  }
  
  // Identifiers (Blue)
  if (/id|uuid|hash|path|host|service|source|rule|incident|pattern|key|digest/i.test(keyLower)) {
    return '#3b82f6' // blue
  }
  
  // Metrics/Counts (Purple)
  if (/count|total|events|lines|created|processed|ingested|forwarded|skipped|latency|duration|elapsed|time|ms|bytes|size|memory|cpu|peak|swap/i.test(keyLower)) {
    return '#a78bfa' // purple
  }
  
  // Confidence/Scores (Cyan)
  if (/confidence|score|probability|threshold|ratio|percent|%/i.test(keyLower)) {
    return '#06b6d4' // cyan
  }
  
  // Model/Config fields (Yellow)
  if (/model|interval|window|temperature|version|config|setting/i.test(keyLower)) {
    return '#eab308' // yellow
  }
  
  // Default: accent color
  return 'var(--accent)'
}

/**
 * Parses and formats structured log messages
 * Handles patterns like: [TIMESTAMP] [LEVEL] key1=value1 key2=value2 message text
 */
export function FormattedMessage({ message }: { message: string }) {
  if (hasAnsiSgr(message)) {
    return <AnsiText message={message} />
  }

  // Try to parse structured log format
  const structuredMatch = message.match(/^\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.*)$/)
  
  if (structuredMatch) {
    const [, timestamp, level, rest] = structuredMatch
    
    // Extract key=value pairs
    const fieldRegex = /(\w+)=([^\s]+)/g
    const fields: Array<[string, string]> = []
    let lastIndex = 0
    let match
    
    while ((match = fieldRegex.exec(rest)) !== null) {
      fields.push([match[1], match[2]])
      lastIndex = match.index + match[0].length
    }
    
    const remainingText = rest.substring(lastIndex).trim()
    
    if (fields.length > 0) {
      return (
        <div style={{ fontFamily: 'monospace', fontSize: '0.78rem', lineHeight: '1.5' }}>
          <div style={{ marginBottom: '0.5rem', color: 'var(--muted-fg)' }}>
            <span style={{ color: 'var(--fg)', fontWeight: 500 }}>Timestamp:</span> {timestamp} | <span style={{ color: 'var(--fg)', fontWeight: 500 }}>Level:</span> {level}
          </div>
          {fields.length > 0 && (
            <div style={{ marginBottom: '0.5rem', display: 'grid', gridTemplateColumns: '1fr', gap: '0.25rem' }}>
              {fields.map(([key, value]) => (
                <div key={key}>
                  <span style={{ color: getFieldColor(key, value), fontWeight: 600 }}>{key}</span>
                  <span style={{ color: 'var(--muted-fg)' }}>=</span>
                  <span style={{ color: 'var(--fg)' }}>{value}</span>
                </div>
              ))}
            </div>
          )}
          {remainingText && (
            <div style={{ marginTop: '0.5rem', color: 'var(--fg)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {remainingText}
            </div>
          )}
        </div>
      )
    }
  }
  
  // Fallback to plain text display
  return (
    <pre style={{
      margin: 0,
      padding: '0.5rem',
      background: 'var(--surface)',
      borderRadius: 6,
      color: 'var(--fg)',
      fontFamily: 'monospace',
      fontSize: '0.78rem',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
    }}>
      {message}
    </pre>
  )
}
