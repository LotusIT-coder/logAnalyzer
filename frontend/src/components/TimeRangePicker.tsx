// Shared time-range preset picker. Used by Dashboard and Events.
// `rangeHours === 0` means "all data, no time filter".

import { useI18n } from '../ctx/I18nContext'

export const TIME_PRESETS: { label: string; hours: number }[] = [
  { label: '1 m', hours: 1 / 60 },
  { label: '15 m', hours: 0.25 },
  { label: '1 h', hours: 1 },
  { label: '6 h', hours: 6 },
  { label: '24 h', hours: 24 },
  { label: '7 d', hours: 168 },
  { label: '30 d', hours: 720 },
  { label: 'time.all', hours: 0 },
]

interface Props {
  value: number
  onChange: (hours: number) => void | Promise<void>
  disabled?: boolean
}

export function TimeRangePicker({ value, onChange, disabled = false }: Props) {
  const { t } = useI18n()
  return (
    <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
      {TIME_PRESETS.map(p => {
        const active = Math.abs(value - p.hours) < 1e-9
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
    </div>
  )
}
