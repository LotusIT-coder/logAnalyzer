/**
 * Lower bound for any client-driven `refetchInterval` (in ms).
 *
 * Centralised so a single config or UX experiment cannot accidentally
 * hammer the backend (e.g. a 100 ms poll). All TanStack Query call sites
 * that derive their interval from a user-controlled value should clamp via
 * `Math.max(MIN_REFRESH_INTERVAL_MS, value)`.
 */
export const MIN_REFRESH_INTERVAL_MS = 1000
