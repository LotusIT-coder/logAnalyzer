import { useId, useState } from 'react'

export default function HelpTip({
  content,
  ariaLabel = 'Mehr Informationen',
}: {
  content: string
  ariaLabel?: string
}) {
  const tooltipId = useId()
  const [open, setOpen] = useState(false)

  return (
    <span
      style={styles.wrap}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        aria-describedby={open ? tooltipId : undefined}
        onClick={() => setOpen(value => !value)}
        onBlur={() => setOpen(false)}
        style={{
          ...styles.button,
          ...(open ? styles.buttonActive : null),
        }}
      >
        i
      </button>
      {open && (
        <span id={tooltipId} role="tooltip" style={styles.tooltip}>
          {content}
        </span>
      )}
    </span>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    verticalAlign: 'middle',
  },
  button: {
    width: 15,
    height: 15,
    borderRadius: 999,
    border: '1px solid rgba(148, 163, 184, 0.32)',
    background: 'rgba(15, 23, 42, 0.45)',
    color: '#94a3b8',
    fontSize: '0.62rem',
    fontWeight: 600,
    lineHeight: 1,
    cursor: 'help',
    padding: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.82,
  },
  buttonActive: {
    border: '1px solid rgba(148, 163, 184, 0.52)',
    background: 'rgba(15, 23, 42, 0.88)',
    color: '#e2e8f0',
    opacity: 1,
  },
  tooltip: {
    position: 'absolute',
    top: 'calc(100% + 0.4rem)',
    right: 0,
    zIndex: 30,
    minWidth: 220,
    maxWidth: 280,
    padding: '0.55rem 0.7rem',
    borderRadius: 10,
    border: '1px solid rgba(51, 65, 85, 0.9)',
    background: 'rgba(15, 23, 42, 0.96)',
    color: '#cbd5e1',
    boxShadow: '0 12px 28px rgba(2, 6, 23, 0.32)',
    fontSize: '0.75rem',
    lineHeight: 1.45,
  },
}