import { useEffect } from 'react'

export function useEscapeToClose(onClose: () => void, enabled: boolean = true) {
  useEffect(() => {
    if (!enabled) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, onClose])
}
