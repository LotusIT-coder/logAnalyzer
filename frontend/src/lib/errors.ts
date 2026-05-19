export function getApiErrorMessage(error: unknown, fallback = 'Unbekannter Fehler') {
  if (!error || typeof error !== 'object') return fallback

  const candidate = error as {
    message?: unknown
    code?: unknown
    response?: {
      status?: unknown
      data?: {
        code?: unknown
        detail?: unknown
        message?: unknown
      }
    }
  }

  const status = candidate.response?.status
  const apiCode = candidate.response?.data?.code
  const ownCode = candidate.code
  if (status === 504 || apiCode === 'HTTP_504' || ownCode === 'ECONNABORTED') {
    return 'Die Abfrage hat das Server-Zeitlimit erreicht. Bitte kleineres Zeitfenster oder weniger Quellen waehlen.'
  }

  const detail = candidate.response?.data?.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (detail && typeof detail === 'object') {
    const detailMessage = (detail as { message?: unknown }).message
    if (typeof detailMessage === 'string' && detailMessage.trim()) return detailMessage
  }

  const message = candidate.response?.data?.message
  if (typeof message === 'string' && message.trim()) return message

  const ownMessage = candidate.message
  if (typeof ownMessage === 'string' && ownMessage.trim()) return ownMessage

  return fallback
}