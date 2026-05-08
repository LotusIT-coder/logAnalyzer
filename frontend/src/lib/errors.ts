export function getApiErrorMessage(error: unknown, fallback = 'Unbekannter Fehler') {
  if (!error || typeof error !== 'object') return fallback

  const candidate = error as {
    message?: unknown
    response?: {
      data?: {
        detail?: unknown
        message?: unknown
      }
    }
  }

  const detail = candidate.response?.data?.detail
  if (typeof detail === 'string' && detail.trim()) return detail

  const message = candidate.response?.data?.message
  if (typeof message === 'string' && message.trim()) return message

  const ownMessage = candidate.message
  if (typeof ownMessage === 'string' && ownMessage.trim()) return ownMessage

  return fallback
}