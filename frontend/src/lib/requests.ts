import { api } from './api'

export type TokenRole = 'viewer' | 'analyst' | 'operator' | 'admin'

export interface MeResponse {
  subject: string
  role: TokenRole
  scopes: string[]
  user_id?: string | null
}

export interface UserResponse {
  id: string
  name: string
  email: string
  role: TokenRole
  enabled: boolean
}

export interface UserListResponse {
  items: UserResponse[]
}

export interface TokenListItem {
  id: string
  name: string
  role: TokenRole
  user_id?: string | null
  scopes: string[]
  created_at: string
  revoked_at?: string | null
}

export interface TokenListResponse {
  items: TokenListItem[]
}

export interface CreateUserRequest {
  name: string
  email: string
  password: string
  role: TokenRole
  enabled?: boolean
}

export interface CreateTokenRequest {
  name: string
  role: TokenRole
  user_id?: string
  scopes?: string[]
}

export interface CreateTokenResponse {
  token: string
  token_id: string
}

export interface PasswordLoginRequest {
  email: string
  password: string
}

export async function getMe() {
  const r = await api.get('/auth/me')
  return r.data as MeResponse
}

export async function loginWithPassword(body: PasswordLoginRequest) {
  const r = await api.post('/auth/login', body)
  return r.data as CreateTokenResponse
}

export async function getUsers() {
  const r = await api.get('/auth/users')
  return r.data as UserListResponse
}

export async function createUser(body: CreateUserRequest) {
  const r = await api.post('/auth/users', body)
  return r.data as UserResponse
}

export async function getTokens() {
  const r = await api.get('/auth/tokens')
  return r.data as TokenListResponse
}

export async function createToken(body: CreateTokenRequest) {
  const r = await api.post('/auth/token', body)
  return r.data as CreateTokenResponse
}

export async function revokeToken(id: string) {
  const r = await api.post(`/auth/tokens/${id}/revoke`)
  return r.data as TokenListItem
}

export async function getSources() {
  const r = await api.get('/sources')
  return (r.data?.items ?? r.data) as any[]
}

export async function createSource(body: object) {
  const r = await api.post('/sources', body)
  return r.data
}

export async function patchSource(id: string, body: object) {
  const r = await api.patch(`/sources/${id}`, body)
  return r.data
}

export async function deleteSource(id: string) {
  await api.delete(`/sources/${id}`)
}

export async function testSource(id: string) {
  const r = await api.post(`/sources/${id}/test`)
  return r.data
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
  return r.data
}

export async function getEvents(params?: object) {
  const r = await api.get('/events', { params })
  return r.data as { items: any[]; next_cursor?: string }
}

export async function getIncidents(params?: object) {
  const r = await api.get('/incidents', { params })
  return r.data as { items: any[] }
}

export async function patchIncident(id: string, body: object) {
  const r = await api.patch(`/incidents/${id}`, body)
  return r.data
}

export async function getRules() {
  const r = await api.get('/rules')
  return r.data as { items: any[] }
}

export async function createRule(body: object) {
  const r = await api.post('/rules', body)
  return r.data
}

export async function patchRule(id: string, body: object) {
  const r = await api.patch(`/rules/${id}`, body)
  return r.data
}

export async function getTimeseries(params?: object) {
  const r = await api.get('/metrics/timeseries', { params })
  return r.data as { bucket: string; points: { ts: string; count: number }[] }
}

export interface TimeRange { from: string; to: string }

export interface MetricsFilter {
  sourceIds?: string[]
  sourcePaths?: string[]
}

export interface NetworkGeoPoint {
  resolved_ip?: string | null
  latitude: number
  longitude: number
  city?: string | null
  region?: string | null
  country?: string | null
  country_code?: string | null
  source: string
}

export interface NetworkMapNode {
  id: string
  label: string
  kind: string
  total_bytes: number
  total_connections: number
  risk_score: number
  geo?: NetworkGeoPoint | null
}

export interface NetworkMapEdge {
  source: string
  target: string
  app?: string | null
  protocol?: string | null
  dst_port?: number | null
  bytes: number
  connections: number
  allowed_count: number
  blocked_count: number
  anomaly_score: number
}

export interface NetworkMapResponse {
  nodes: NetworkMapNode[]
  edges: NetworkMapEdge[]
}

function withMetricsFilter(base: Record<string, any>, range?: TimeRange, filter?: MetricsFilter) {
  const params: Record<string, any> = { ...base }
  if (range?.from) params.from = range.from
  if (range?.to) params.to = range.to
  if (filter?.sourceIds?.length) params.source_ids = filter.sourceIds.join(',')
  if (filter?.sourcePaths?.length) params.source_paths = filter.sourcePaths.join(',')
  return params
}

export async function getTopErrors(range?: TimeRange, filter?: MetricsFilter) {
  const r = await api.get('/metrics/top-errors', { params: withMetricsFilter({}, range, filter) })
  return r.data as { items: { message: string; count: number; key?: string }[] }
}

export async function getTopServices(range?: TimeRange, filter?: MetricsFilter) {
  const r = await api.get('/metrics/top-services', { params: withMetricsFilter({}, range, filter) })
  return r.data as { items: { service: string; count: number }[] }
}

export async function getErrorRate(range?: TimeRange, filter?: MetricsFilter) {
  const r = await api.get('/metrics/error-rate', { params: withMetricsFilter({}, range, filter) })
  return r.data as { total_events: number; error_events: number; error_rate: number }
}

export async function getNetworkMap(range?: TimeRange, filter?: MetricsFilter) {
  const r = await api.get('/metrics/network/map', { params: withMetricsFilter({}, range, filter) })
  return r.data as NetworkMapResponse
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

export async function getAIModels(): Promise<any[]> {
  const r = await api.get('/ai/models')
  // backend returns { items: [...] }
  return r.data?.items ?? r.data?.models ?? (Array.isArray(r.data) ? r.data : [])
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
  return r.data as {
    source_id: string
    source_name: string
    stored_path: string
    lines_ingested: number
    events_created: number
  }
}

export async function getParserProfiles() {
  const r = await api.get('/parser-profiles')
  return r.data as any[]
}

export async function getModelProfiles() {
  const r = await api.get('/model-profiles')
  return r.data as any[]
}
