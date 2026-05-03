import { api } from './api'

export async function getMe() {
  const r = await api.get('/auth/me')
  return r.data as { subject: string; scopes: string[] }
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

export async function runIngestion(opts?: { sourceIds?: string[]; extraPaths?: string[] }) {
  const body: Record<string, unknown> = {}
  if (opts?.sourceIds?.length) body.source_ids = opts.sourceIds
  if (opts?.extraPaths?.length) body.extra_paths = opts.extraPaths
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

export async function getTopErrors() {
  const r = await api.get('/metrics/top-errors')
  return r.data as { items: { message: string; count: number }[] }
}

export async function getTopServices() {
  const r = await api.get('/metrics/top-services')
  return r.data as { items: { service: string; count: number }[] }
}

export async function getErrorRate() {
  const r = await api.get('/metrics/error-rate')
  return r.data as { total_events: number; error_events: number; error_rate: number }
}

export async function aiChat(model: string, message: string) {
  const r = await api.post('/ai/chat', {
    model,
    messages: [{ role: 'user', content: message }],
  })
  return r.data as { response: string }
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
