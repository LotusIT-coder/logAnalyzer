// Shared time-range preset picker. Used by Dashboard and Events.

import { useMemo, useState } from 'react'
import { useI18n } from '../ctx/I18nContext'

export const TIME_PRESETS: { label: string; hours: number }[] = [
  { label: '1 m', hours: 1 / 60 },
  { label: '15 m', hours: 0.25 },
  { label: '1 h', hours: 1 },
  { label: '6 h', hours: 6 },
  { label: '24 h', hours: 24 },
  { label: '7 d', hours: 168 },
]

export interface ManualTimeRange {
  from?: string
  to?: string
}

interface Props {
  value: number
  onChange: (hours: number) => void | Promise<void>
  manualRange?: ManualTimeRange
  onManualRangeChange?: (range?: ManualTimeRange) => void | Promise<void>
  disabled?: boolean
}

function isoToLocalInput(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function localInputToIso(value: string) {
  if (!value) return undefined
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toISOString()
}

export function TimeRangePicker({ value, onChange, manualRange, onManualRangeChange, disabled = false }: Props) {
  const { t } = useI18n()
  const hasManualRange = Boolean(manualRange?.from || manualRange?.to)
  const [isManualOpen, setIsManualOpen] = useState(false)
  const [manualFromInput, setManualFromInput] = useState('')
  const [manualToInput, setManualToInput] = useState('')
  const [manualError, setManualError] = useState<string | null>(null)

  const activePresetHours = hasManualRange ? NaN : value

  const manualDefaults = useMemo(() => {
    const now = new Date()
    const before = new Date(now.getTime() - 24 * 3600_000)
    return {
      from: isoToLocalInput(manualRange?.from) || isoToLocalInput(before.toISOString()),
      to: isoToLocalInput(manualRange?.to) || isoToLocalInput(now.toISOString()),
    }
  }, [manualRange?.from, manualRange?.to])

  function openManualEditor() {
    setManualError(null)
    setManualFromInput(manualDefaults.from)
    setManualToInput(manualDefaults.to)
    setIsManualOpen(true)
  }

  async function applyManualRange() {
    const fromIso = localInputToIso(manualFromInput)
    const toIso = localInputToIso(manualToInput)

    if (!fromIso && !toIso) {
      setManualError('Bitte mindestens Start oder Ende setzen.')
      return
    }

    if (fromIso && toIso && new Date(fromIso).getTime() >= new Date(toIso).getTime()) {
      setManualError('Start muss vor Ende liegen.')
      return
    }

    setManualError(null)
    await onManualRangeChange?.({ from: fromIso, to: toIso })
    setIsManualOpen(false)
  }

  async function clearManualRange() {
    setManualError(null)
    setIsManualOpen(false)
    await onManualRangeChange?.(undefined)
  }

  return (
    <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center', flexWrap: 'wrap' }}>
        {TIME_PRESETS.map(p => {
          const active = Math.abs(activePresetHours - p.hours) < 1e-9
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => onChange(p.hours)}
              disabled={disabled}
              style={{
                padding: '0.25rem 0.6rem',
                fontSize: '0.8rem',
                borderRadius: '0.375rem',
                border: '1px solid',
                cursor: disabled ? 'not-allowed' : 'pointer',
                background: active ? 'var(--accent)' : 'var(--surface)',
                color: active ? '#fff' : 'var(--muted-fg)',
                borderColor: active ? 'var(--accent)' : 'var(--border)',
                opacity: disabled ? 0.6 : 1,
              }}
            >
              {p.label.startsWith('time.') ? t(p.label) : p.label}
            </button>
          )
        })}
        <button
          type="button"
          onClick={openManualEditor}
          disabled={disabled || !onManualRangeChange}
          style={{
            padding: '0.25rem 0.6rem',
            fontSize: '0.8rem',
            borderRadius: '0.375rem',
            border: '1px solid',
            cursor: disabled || !onManualRangeChange ? 'not-allowed' : 'pointer',
            background: hasManualRange ? 'var(--accent)' : 'var(--surface)',
            color: hasManualRange ? '#fff' : 'var(--muted-fg)',
            borderColor: hasManualRange ? 'var(--accent)' : 'var(--border)',
            opacity: disabled || !onManualRangeChange ? 0.6 : 1,
          }}
        >
          Manuell
        </button>
        {hasManualRange && (
          <button
            type="button"
            onClick={() => void clearManualRange()}
            disabled={disabled || !onManualRangeChange}
            style={{
              padding: '0.25rem 0.6rem',
              fontSize: '0.8rem',
              borderRadius: '0.375rem',
              border: '1px solid var(--border)',
              cursor: disabled || !onManualRangeChange ? 'not-allowed' : 'pointer',
              background: 'var(--surface)',
              color: 'var(--muted-fg)',
              opacity: disabled || !onManualRangeChange ? 0.6 : 1,
            }}
          >
            Zurueck
          </button>
        )}
      </div>

      {isManualOpen && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
            flexWrap: 'wrap',
            padding: '0.4rem',
            border: '1px solid var(--border)',
            borderRadius: '0.5rem',
            background: 'var(--surface)',
          }}
        >
          <input
            type="datetime-local"
            value={manualFromInput}
            onChange={event => setManualFromInput(event.target.value)}
            style={{
              border: '1px solid var(--border)',
              borderRadius: '0.35rem',
              padding: '0.28rem 0.4rem',
              background: 'var(--surface)',
              color: 'var(--fg)',
              fontSize: '0.78rem',
            }}
          />
          <span style={{ color: 'var(--muted-fg)', fontSize: '0.78rem' }}>bis</span>
          <input
            type="datetime-local"
            value={manualToInput}
            onChange={event => setManualToInput(event.target.value)}
            style={{
              border: '1px solid var(--border)',
              borderRadius: '0.35rem',
              padding: '0.28rem 0.4rem',
              background: 'var(--surface)',
              color: 'var(--fg)',
              fontSize: '0.78rem',
            }}
          />
          <button
            type="button"
            onClick={() => void applyManualRange()}
            style={{
              padding: '0.25rem 0.6rem',
              fontSize: '0.78rem',
              borderRadius: '0.35rem',
              border: '1px solid var(--accent)',
              background: 'var(--accent)',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            Anwenden
          </button>
          <button
            type="button"
            onClick={() => setIsManualOpen(false)}
            style={{
              padding: '0.25rem 0.6rem',
              fontSize: '0.78rem',
              borderRadius: '0.35rem',
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--muted-fg)',
              cursor: 'pointer',
            }}
          >
            Abbrechen
          </button>
          {manualError && <span style={{ color: 'var(--danger-fg)', fontSize: '0.75rem' }}>{manualError}</span>}
        </div>
      )}
    </div>
  )
}
