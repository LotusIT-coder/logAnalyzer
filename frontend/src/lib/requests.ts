import { api } from './api'

type QueryParams = Record<string, string | number | boolean | undefined>
type JsonObject = Record<string, unknown>

export interface SourceConfig extends JsonObject {
  path?: string
}

export interface SourceResponse {
  id: string
  name: string
  type: string
  enabled: boolean
  config: SourceConfig
}

export interface SourceTestResponse extends JsonObject {
  ok?: boolean
  error?: string | null
  details?: string | null
}

export interface SourceIngestionStatus {
  source_id: string
  last_ingested_at?: string | null
  last_event_timestamp?: string | null
  last_event_created_at?: string | null
}

export interface IngestionRunEntry extends JsonObject {
  path?: string
  source_name?: string
  source_id?: string
  lines_ingested?: number
  events_created?: number
  skipped?: boolean
  reason?: string
  source_origin?: 'preset' | 'custom' | string
}

export interface IngestionRunResponse extends JsonObject {
  results?: IngestionRunEntry[]
}

export interface EventResponse extends JsonObject {
  id: string
  source_id?: string | null
  timestamp: string
  severity: string
  host?: string | null
  service?: string | null
  message: string
}

export interface EventListResponse {
  items: EventResponse[]
  next_cursor?: string | null
}

export interface IncidentResponse extends JsonObject {
  id: string
  title: string
  status: string
  severity: string
  event_count: number
  first_seen: string
  last_seen: string
}

export interface IncidentListResponse {
  items: IncidentResponse[]
}

export interface RuleResponse extends JsonObject {
  id: string
  name: string
  description?: string
  condition?: Record<string, unknown>
  severity: string
  threshold: number
  window_seconds: number
  enabled: boolean
}

export interface RuleListResponse {
  items: RuleResponse[]
}

export interface AIModelResponse extends JsonObject {
  name: string
}

export interface ParserProfileResponse extends JsonObject {
  name: string
}

export interface ModelProfileResponse extends JsonObject {
  name: string
}

export interface TimeseriesPoint {
  ts: string
  count: number
}

export interface TimeseriesResponse {
  bucket: string
  points: TimeseriesPoint[]
}

export interface TopErrorItem {
  message?: string
  count: number
  key?: string
}

export interface TopErrorsResponse {
  items: TopErrorItem[]
}

export interface TopServiceItem {
  service: string
  count: number
}

export interface TopServicesResponse {
  items: TopServiceItem[]
}

export interface ErrorRateResponse {
  total_events: number
  error_events: number
  error_rate: number
}

export interface UploadImportResponse {
  source_id: string
  source_name: string
  stored_path: string
  lines_ingested: number
  events_created: number
}

export async function getSources() {
  const r = await api.get('/sources')
  return (r.data?.items ?? r.data) as SourceResponse[]
}

export async function createSource(body: JsonObject) {
  const r = await api.post('/sources', body)
  return r.data as SourceResponse
}

export async function patchSource(id: string, body: JsonObject) {
  const r = await api.patch(`/sources/${id}`, body)
  return r.data as SourceResponse
}

export async function deleteSource(id: string) {
  await api.delete(`/sources/${id}`)
}

export async function testSource(id: string) {
  const r = await api.post(`/sources/${id}/test`)
  return r.data as SourceTestResponse
}

export async function getSourceIngestionStatus(sourceIds?: string[]) {
  const params: QueryParams = {}
  if (sourceIds?.length) params.source_ids = sourceIds.join(',')
  const r = await api.get('/sources/status', { params })
  return (r.data?.items ?? r.data) as SourceIngestionStatus[]
}

export async function runIngestion(opts?: {
  sourceIds?: string[]
  extraPaths?: string[]
  extraEntries?: Array<{ path: string; origin: 'preset' | 'custom' }>
}) {
  const body: Record<string, unknown> = {}
  if (opts?.sourceIds !== undefined) body.source_ids = opts.sourceIds
  if (opts?.extraPaths?.length) body.extra_paths = opts.extraPaths
  if (opts?.extraEntries?.length) body.extra_entries = opts.extraEntries
  const r = await api.post('/ingestion/run', body)
  return r.data as IngestionRunResponse
}

export async function getEvents(params?: object) {
  const r = await api.get('/events', { params })
  return r.data as EventListResponse
}

export async function getIncidents(params?: QueryParams) {
  const r = await api.get('/incidents', { params })
  return r.data as IncidentListResponse
}

export async function patchIncident(id: string, body: JsonObject) {
  const r = await api.patch(`/incidents/${id}`, body)
  return r.data as IncidentResponse
}

export async function getRules() {
  const r = await api.get('/rules')
  return r.data as RuleListResponse
}

export async function createRule(body: JsonObject) {
  const r = await api.post('/rules', body)
  return r.data as RuleResponse
}

export async function patchRule(id: string, body: JsonObject) {
  const r = await api.patch(`/rules/${id}`, body)
  return r.data as RuleResponse
}

export async function deleteRule(id: string) {
  await api.delete(`/rules/${id}`)
}

export async function getTimeseries(params?: QueryParams) {
  const r = await api.get('/metrics/timeseries', { params })
  return r.data as TimeseriesResponse
}

export interface TimeRange { from: string; to: string }

export interface MetricsFilter {
  sourceIds?: string[]
  sourcePaths?: string[]
}

function withMetricsFilter(base: QueryParams, range?: TimeRange, filter?: MetricsFilter) {
  const params: QueryParams = { ...base }
  if (range?.from) params.from = range.from
  if (range?.to) params.to = range.to
  if (filter?.sourceIds?.length) params.source_ids = filter.sourceIds.join(',')
  if (filter?.sourcePaths?.length) params.source_paths = filter.sourcePaths.join(',')
  return params
}

export async function getTopErrors(range?: TimeRange, filter?: MetricsFilter) {
  const r = await api.get('/metrics/top-errors', { params: withMetricsFilter({}, range, filter) })
  return r.data as TopErrorsResponse
}

export async function getTopServices(range?: TimeRange, filter?: MetricsFilter) {
  const r = await api.get('/metrics/top-services', { params: withMetricsFilter({}, range, filter) })
  return r.data as TopServicesResponse
}

export async function getErrorRate(range?: TimeRange, filter?: MetricsFilter) {
  const r = await api.get('/metrics/error-rate', { params: withMetricsFilter({}, range, filter) })
  return r.data as ErrorRateResponse
}

export async function aiChat(model: string, message: string) {
  const r = await api.post('/ai/chat', { message, model })
  return r.data as { answer: string; references: string[] }
}

export interface SourceFilter {
  sourceIds?: string[]
  sourcePaths?: string[]
  rangeHours?: number
}

export interface AIContextPayload {
  kind: string
  title: string
  summary: string
  details?: Record<string, unknown>
  prompt?: string
}

export interface AIChatOptions extends SourceFilter {
  context?: AIContextPayload | null
}

export async function aiChatAsync(model: string, message: string, filter?: AIChatOptions): Promise<{ job_id: string }> {
  const r = await api.post('/ai/chat/async', {
    message,
    model,
    source_ids: filter?.sourceIds,
    source_paths: filter?.sourcePaths,
    since_hours: filter?.rangeHours,
    context: filter?.context,
  })
  return r.data
}

export async function getAIJob(jobId: string) {
  const r = await api.get(`/ai/jobs/${jobId}`)
  return r.data as { id: string; status: string; result: { answer: string; references: string[] } | null; error: string | null }
}

export async function getAIModels(): Promise<AIModelResponse[]> {
  const r = await api.get('/ai/models')
  // backend returns { items: [...] }
  return (r.data?.items ?? r.data?.models ?? (Array.isArray(r.data) ? r.data : [])) as AIModelResponse[]
}

export async function analyzeUpload(file: File, model?: string, prompt?: string) {
  const fd = new FormData()
  fd.append('file', file)
  if (model) fd.append('model', model)
  if (prompt) fd.append('prompt', prompt)
  const r = await api.post('/upload/analyze', fd)
  return r.data
}

export async function uploadImport(file: File, sourceName?: string) {
  const fd = new FormData()
  fd.append('file', file)
  if (sourceName) fd.append('source_name', sourceName)
  const r = await api.post('/upload/import', fd)
  return r.data as UploadImportResponse
}

export async function getParserProfiles() {
  const r = await api.get('/parser-profiles')
  return r.data as ParserProfileResponse[]
}

export async function getModelProfiles() {
  const r = await api.get('/model-profiles')
  return r.data as ModelProfileResponse[]
}
