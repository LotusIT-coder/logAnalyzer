import { useEffect, useState } from 'react'

/**
 * Returns a counter that increments every `intervalMs` milliseconds.
 *
 * Use this in components that render age-based labels (e.g. "vor 5 min") so
 * the labels stay current without user interaction. Read the returned value
 * (or just call the hook) to subscribe the component to the tick.
 *
 * The internal counter wraps to keep it bounded and avoid floating-point
 * concerns over long-running sessions.
 */
export function useTick(intervalMs: number = 1000, modulo: number = 3600): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick(prev => (prev + 1) % modulo), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs, modulo])
  return tick
}
