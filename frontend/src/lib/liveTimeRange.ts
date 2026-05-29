import type { SourceIngestionStatus, TimeRange } from './requests'
import type { ManualTimeRange } from '../components/TimeRangePicker'

const LIVE_ANCHORED_MAX_RANGE_HOURS = 1 / 60
const LIVE_ANCHOR_PAD_MS = 1_000

function parseTime(value?: string | null) {
  if (!value) return Number.NaN
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

export function getFreshestSourceActivityMs(statuses?: SourceIngestionStatus[]) {
  if (!statuses?.length) return undefined

  const primaryTimes = statuses
    .flatMap(status => [status.last_event_created_at, status.last_seen_at, status.last_ingested_at])
    .map(parseTime)
    .filter(Number.isFinite)

  if (primaryTimes.length > 0) return Math.max(...primaryTimes)

  const fallbackTimes = statuses
    .map(status => parseTime(status.last_event_timestamp))
    .filter(Number.isFinite)

  return fallbackTimes.length > 0 ? Math.max(...fallbackTimes) : undefined
}

export function buildLiveTimeRange(
  rangeHours: number,
  serverTimeOffset = 0,
  manualRange?: ManualTimeRange,
  sourceStatuses?: SourceIngestionStatus[],
  nowMs = Date.now(),
): TimeRange | undefined {
  const serverNowMs = nowMs + serverTimeOffset
  const nowIso = new Date(serverNowMs).toISOString()

  if (manualRange && (manualRange.from || manualRange.to)) {
    return {
      from: manualRange.from ?? '1970-01-01T00:00:00.000Z',
      to: manualRange.to ?? nowIso,
    }
  }

  if (rangeHours <= 0) return undefined

  const rangeMs = rangeHours * 3600_000
  const defaultFromMs = serverNowMs - rangeMs
  let toMs = serverNowMs

  if (rangeHours <= LIVE_ANCHORED_MAX_RANGE_HOURS) {
    const freshestMs = getFreshestSourceActivityMs(sourceStatuses)
    if (freshestMs !== undefined && (freshestMs < defaultFromMs || freshestMs > serverNowMs)) {
      toMs = freshestMs + LIVE_ANCHOR_PAD_MS
    }
  }

  return {
    from: new Date(toMs - rangeMs).toISOString(),
    to: new Date(toMs).toISOString(),
  }
}
