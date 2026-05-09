import { useEffect, useId, useRef, useState } from 'react'

export default function HelpTip({
  content,
  ariaLabel = 'Mehr Informationen',
}: {
  content: string
  ariaLabel?: string
}) {
  const tooltipId = useId()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const tipRef = useRef<HTMLSpanElement | null>(null)
  const [tipPos, setTipPos] = useState<{ left: number; top: number }>({ left: 8, top: 8 })

  useEffect(() => {
    if (!open) return

    function updatePosition() {
      const wrapEl = wrapRef.current
      const tipEl = tipRef.current
      if (!wrapEl || !tipEl) return

      const rect = wrapEl.getBoundingClientRect()
      const tipWidth = tipEl.offsetWidth || 260
      const margin = 8
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - tipWidth - margin))
      const top = rect.bottom + 8
      setTipPos({ left, top })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  return (
    <span
      ref={wrapRef}
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
        <span
          ref={tipRef}
          id={tooltipId}
          role="tooltip"
          style={{
            ...styles.tooltip,
            left: tipPos.left,
            top: tipPos.top,
          }}
        >
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
    position: 'fixed',
    zIndex: 400,
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