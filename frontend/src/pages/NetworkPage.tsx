import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import HelpTip from '../components/HelpTip'
import { useAIChat } from '../ctx/AIChatContext'
import { getApiBase, getStoredToken } from '../lib/api'
import { getNetworkMap, type AIContextPayload, type NetworkGeoPoint, type NetworkMapEdge, type NetworkMapNode, type NetworkMapResponse, type TimeRange } from '../lib/requests'

const LIVE_WINDOW_MS = 60_000
const DEFAULT_NETWORK_WINDOW_HOURS = 24
const NETWORK_TIME_PRESETS: Array<{ label: string; hours: number }> = [
  { label: '1 h', hours: 1 },
  { label: '6 h', hours: 6 },
  { label: '24 h', hours: 24 },
  { label: '7 d', hours: 168 },
  { label: 'Alle', hours: 0 },
]
const NETWORK_STREAM_HINTS = [
  'authenticate with',
  'associate with',
  'disconnect from ap',
  'rx assocresp',
  'rx reassocresp',
  'group rekeying completed',
  'local address=',
  '"ip":',
  '"client_ip":',
  '"remote_ip":',
  '"host":',
  'dhcp4',
  'dhcp6',
]

type StreamedEvent = {
  id?: string
  timestamp?: string
  created_at?: string
  event_type?: string | null
  service?: string | null
  host?: string | null
  message?: string
  fields?: Record<string, unknown>
}

type LiveTrafficSample = {
  id: string
  source: string
  target: string
  app: string
  protocol: string
  dstPort: number | null
  bytes: number
  timestamp: string
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatClock(value?: string | number | null) {
  if (value == null) return 'noch keine Aktivitaet'
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return 'noch keine Aktivitaet'
  return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function parseNetworkWindowHours(rawValue: string | null) {
  if (!rawValue) return DEFAULT_NETWORK_WINDOW_HOURS
  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_NETWORK_WINDOW_HOURS
  return NETWORK_TIME_PRESETS.some(preset => preset.hours === parsed) ? parsed : DEFAULT_NETWORK_WINDOW_HOURS
}

function buildNetworkTimeRange(hours: number): TimeRange | undefined {
  if (hours === 0) return undefined
  const now = Date.now()
  return {
    from: new Date(now - hours * 3600_000).toISOString(),
    to: new Date(now).toISOString(),
  }
}

function formatNetworkWindowLabel(hours: number) {
  return NETWORK_TIME_PRESETS.find(preset => preset.hours === hours)?.label ?? `${hours} h`
}

function coerceNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function normalizeNetworkValue(value: unknown) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed === '?') return null
  if (trimmed.includes('://')) {
    try {
      return new URL(trimmed).hostname || trimmed
    } catch {
      return trimmed
    }
  }
  return trimmed
}

function extractMessagePayload(message?: string) {
  if (!message) return null
  const start = message.indexOf('{')
  const end = message.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const payload = JSON.parse(message.slice(start, end + 1))
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
  } catch {
    return null
  }
}

function inferMessageEdge(event: StreamedEvent) {
  const payload = extractMessagePayload(event.message)
  if (payload) {
    const request = payload.request
    if (request && typeof request === 'object') {
      const requestPayload = request as Record<string, unknown>
      const source = normalizeNetworkValue(requestPayload.client_ip ?? requestPayload.remote_ip)
      const target = normalizeNetworkValue(requestPayload.host)
      const protocol = typeof requestPayload.proto === 'string' && requestPayload.proto
        ? requestPayload.proto.split('/', 1)[0].toLowerCase()
        : null
      if (source && target && source !== target) return { source, target, protocol }
    }

    const source = normalizeNetworkValue(event.host ?? payload.nodeId)
    const target = normalizeNetworkValue(payload.ip)
    const protocol = (event.message ?? '').toLowerCase().includes('[ws]') ? 'ws' : null
    if (source && target && source !== target) return { source, target, protocol }
  }

  const dhcpMatch = /dhcp[46][^\n]*address=([^,\s)]+)/i.exec(event.message ?? '')
  if (dhcpMatch) {
    const source = normalizeNetworkValue(event.host)
    const target = normalizeNetworkValue(dhcpMatch[1])
    if (source && target && source !== target) return { source, target, protocol: 'dhcp' }
  }

  return null
}

function inferLiveTrafficSample(event: StreamedEvent): LiveTrafficSample | null {
  const fields = event.fields ?? {}
  let source = normalizeNetworkValue(fields.src_host ?? fields.src_ip ?? event.host)
  let target = normalizeNetworkValue(fields.dst_host ?? fields.dst_ip)
  let protocol = typeof fields.protocol === 'string' && fields.protocol.trim()
    ? fields.protocol.trim().toLowerCase()
    : null

  if (!source || !target) {
    const inferred = inferMessageEdge(event)
    if (inferred) {
      source = source ?? inferred.source
      target = target ?? inferred.target
      protocol = protocol ?? inferred.protocol
    }
  }

  const looksNetwork = event.event_type === 'network_flow' || NETWORK_STREAM_HINTS.some(hint => (event.message ?? '').toLowerCase().includes(hint))
  if (!source || !target || source === target || !looksNetwork) return null

  const bytes = ['bytes', 'bytes_total', 'bytes_in', 'bytes_out']
    .reduce((sum, key) => sum + coerceNumber(fields[key]), 0)
  const dstPort = coerceNumber(fields.dst_port ?? fields.port ?? fields.remote_port)

  return {
    id: event.id ?? `${source}-${target}-${event.created_at ?? event.timestamp ?? Date.now()}`,
    source,
    target,
    app: typeof fields.app === 'string' && fields.app.trim() ? fields.app.trim() : event.service?.trim() || 'unbekannt',
    protocol: protocol ?? 'n/a',
    dstPort: dstPort > 0 ? dstPort : null,
    bytes,
    timestamp: event.created_at ?? event.timestamp ?? new Date().toISOString(),
  }
}

function liveEdgeKey(sample: Pick<LiveTrafficSample, 'source' | 'target' | 'app' | 'protocol' | 'dstPort'>) {
  return `${sample.source}-${sample.target}-${sample.app}-${sample.protocol}-${sample.dstPort ?? 'na'}`
}

function looksLikeIpAddress(value: string) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value)
}

function isPrivateIpAddress(value: string) {
  if (!looksLikeIpAddress(value)) return false
  return value.startsWith('10.')
    || value.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(value)
    || value === '127.0.0.1'
}

function inferNodeKind(nodeId: string) {
  return looksLikeIpAddress(nodeId) && !isPrivateIpAddress(nodeId) ? 'external' : 'host'
}

function applyLiveSamplesToGraph(base: NetworkMapResponse | undefined, samples: LiveTrafficSample[]) {
  const nodeMap = new Map<string, NetworkMapNode>((base?.nodes ?? []).map(node => [node.id, { ...node }]))
  const edgeMap = new Map<string, NetworkMapEdge>()

  for (const edge of base?.edges ?? []) {
    edgeMap.set(liveEdgeKey({
      source: edge.source,
      target: edge.target,
      app: edge.app ?? 'unbekannt',
      protocol: edge.protocol ?? 'n/a',
      dstPort: edge.dst_port ?? null,
    }), { ...edge })
  }

  for (const sample of samples) {
    const sourceNode = nodeMap.get(sample.source) ?? {
      id: sample.source,
      label: sample.source,
      kind: inferNodeKind(sample.source),
      total_bytes: 0,
      total_connections: 0,
      risk_score: 0,
      geo: null,
    }
    const targetNode = nodeMap.get(sample.target) ?? {
      id: sample.target,
      label: sample.target,
      kind: inferNodeKind(sample.target),
      total_bytes: 0,
      total_connections: 0,
      risk_score: 0,
      geo: null,
    }

    sourceNode.total_bytes += sample.bytes
    sourceNode.total_connections += 1
    targetNode.total_bytes += sample.bytes
    targetNode.total_connections += 1
    nodeMap.set(sourceNode.id, sourceNode)
    nodeMap.set(targetNode.id, targetNode)

    const key = liveEdgeKey(sample)
    const edge = edgeMap.get(key) ?? {
      source: sample.source,
      target: sample.target,
      app: sample.app,
      protocol: sample.protocol,
      dst_port: sample.dstPort,
      bytes: 0,
      connections: 0,
      allowed_count: 0,
      blocked_count: 0,
      anomaly_score: 0,
    }
    edge.bytes += sample.bytes
    edge.connections += 1
    edge.allowed_count += 1
    edgeMap.set(key, edge)
  }

  return {
    nodes: Array.from(nodeMap.values()),
    edges: Array.from(edgeMap.values()),
  }
}

function buildDrilldownQuery(params: {
  host?: string
  service?: string
  query?: string
}) {
  const search = new URLSearchParams()
  if (params.host) search.set('host', params.host)
  if (params.service) search.set('service', params.service)
  if (params.query) search.set('q', params.query)
  return `/events?${search.toString()}`
}

function buildNodePositions(nodes: NetworkMapNode[]) {
  const width = 760
  const height = 360
  const centerX = width / 2
  const centerY = height / 2
  const radiusX = 250
  const radiusY = 120

  const positions = new Map<string, { x: number; y: number }>()
  nodes.forEach((node, index) => {
    const angle = (index / Math.max(nodes.length, 1)) * Math.PI * 2 - Math.PI / 2
    positions.set(node.id, {
      x: centerX + Math.cos(angle) * radiusX,
      y: centerY + Math.sin(angle) * radiusY,
    })
  })
  return { width, height, positions }
}

function edgeKey(edge: NetworkMapEdge, index: number) {
  return `${edge.source}-${edge.target}-${edge.app ?? 'na'}-${edge.dst_port ?? 'na'}-${index}`
}

function edgeFocusParam(edge: NetworkMapEdge) {
  return [edge.source, edge.target, edge.app ?? '', edge.protocol ?? '', edge.dst_port ?? ''].join('|')
}

function uniqueEdgeValues(edges: NetworkMapEdge[], selector: (edge: NetworkMapEdge) => string | null | undefined) {
  return Array.from(
    new Set(
      edges
        .map(selector)
        .filter((value): value is string => Boolean(value && value.trim()))
        .map(value => value.trim()),
    ),
  ).sort((left, right) => left.localeCompare(right))
}

type FocusState =
  | { type: 'node'; nodeId: string }
  | { type: 'edge'; edgeKey: string }
  | null

type DetailView = 'nodes' | 'edges' | 'volume' | null

function hasGeo(node: NetworkMapNode): node is NetworkMapNode & { geo: NetworkGeoPoint } {
  return Boolean(node.geo && Number.isFinite(node.geo.latitude) && Number.isFinite(node.geo.longitude))
}

function formatGeoLocation(geo: NetworkGeoPoint) {
  return [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || geo.country_code || geo.resolved_ip || 'Geolokation verfuegbar'
}

function projectGeoPoint(longitude: number, latitude: number, width: number, height: number) {
  const x = 220 + ((longitude + 180) / 360) * (width - 260)
  const y = 36 + ((90 - latitude) / 180) * (height - 72)
  return {
    x: Math.max(220, Math.min(width - 34, x)),
    y: Math.max(36, Math.min(height - 36, y)),
  }
}

const GEO_MAP_POLYGONS: Array<{ id: string; points: Array<[number, number]> }> = [
  {
    id: 'north-america',
    points: [
      [-168, 72], [-150, 68], [-135, 60], [-124, 50], [-118, 36], [-108, 24], [-94, 18], [-82, 24], [-76, 34], [-70, 46], [-62, 54], [-72, 64], [-96, 72], [-130, 75],
    ],
  },
  {
    id: 'south-america',
    points: [
      [-81, 12], [-72, 7], [-68, -6], [-64, -18], [-60, -30], [-55, -42], [-48, -52], [-40, -50], [-36, -36], [-40, -18], [-48, -4], [-58, 8], [-70, 12],
    ],
  },
  {
    id: 'greenland',
    points: [
      [-58, 81], [-42, 79], [-28, 72], [-34, 64], [-48, 60], [-60, 68],
    ],
  },
  {
    id: 'europe-africa',
    points: [
      [-10, 71], [8, 70], [24, 64], [34, 54], [30, 44], [14, 36], [4, 42], [-4, 36], [-10, 26], [-8, 10], [0, -2], [12, -14], [18, -24], [24, -34], [34, -30], [42, -14], [48, 2], [50, 18], [40, 32], [28, 40], [18, 48], [8, 58], [-4, 62],
    ],
  },
  {
    id: 'asia',
    points: [
      [28, 62], [42, 68], [66, 70], [92, 66], [118, 60], [142, 52], [154, 40], [148, 28], [132, 20], [114, 16], [100, 8], [84, 10], [72, 22], [58, 28], [48, 38], [40, 48], [32, 56],
    ],
  },
  {
    id: 'australia',
    points: [
      [110, -12], [126, -14], [144, -22], [150, -34], [142, -42], [128, -40], [116, -30], [110, -20],
    ],
  },
]

function buildGeoPolygonPath(points: Array<[number, number]>, width: number, height: number) {
  return points
    .map(([longitude, latitude], index) => {
      const point = projectGeoPoint(longitude, latitude, width, height)
      return `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`
    })
    .join(' ') + ' Z'
}

function GeoFlowMap({
  nodes,
  edges,
  focus,
  onNodeFocus,
  onEdgeFocus,
}: {
  nodes: NetworkMapNode[]
  edges: NetworkMapEdge[]
  focus: FocusState
  onNodeFocus: (nodeId: string) => void
  onEdgeFocus: (key: string) => void
}) {
  const geoNodes = useMemo(() => nodes.filter(hasGeo), [nodes])
  const localNodes = useMemo(() => nodes.filter(node => !hasGeo(node)), [nodes])
  const geoNodeIds = useMemo(() => new Set(geoNodes.map(node => node.id)), [geoNodes])
  const geoEdges = useMemo(
    () => edges.filter(edge => geoNodeIds.has(edge.source) || geoNodeIds.has(edge.target)),
    [edges, geoNodeIds],
  )
  const layout = useMemo(() => {
    const width = 760
    const height = 320
    const positions = new Map<string, { x: number; y: number }>()
    const localX = 96
    const localSpacing = height / Math.max(localNodes.length + 1, 2)
    localNodes.forEach((node, index) => {
      positions.set(node.id, { x: localX, y: localSpacing * (index + 1) })
    })

    const seenCoordinates = new Map<string, number>()
    geoNodes.forEach(node => {
      const base = projectGeoPoint(node.geo.longitude, node.geo.latitude, width, height)
      const key = `${node.geo.latitude.toFixed(1)}:${node.geo.longitude.toFixed(1)}`
      const duplicateIndex = seenCoordinates.get(key) ?? 0
      seenCoordinates.set(key, duplicateIndex + 1)
      positions.set(node.id, {
        x: base.x + ((duplicateIndex % 3) - 1) * 18,
        y: base.y + Math.floor(duplicateIndex / 3) * 14,
      })
    })

    return { width, height, positions, localX }
  }, [geoNodes, localNodes])

  function isEdgeActive(edge: NetworkMapEdge, index: number) {
    if (!focus) return true
    if (focus.type === 'edge') return edgeKey(edge, index) === focus.edgeKey
    return edge.source === focus.nodeId || edge.target === focus.nodeId
  }

  function isNodeActive(nodeId: string) {
    if (!focus) return true
    if (focus.type === 'node') return nodeId === focus.nodeId || edges.some(edge => (edge.source === focus.nodeId || edge.target === focus.nodeId) && (edge.source === nodeId || edge.target === nodeId))
    const selectedEdge = edges.find((edge, index) => edgeKey(edge, index) === focus.edgeKey)
    return selectedEdge?.source === nodeId || selectedEdge?.target === nodeId
  }

  if (!geoNodes.length && !geoEdges.length) {
    return (
      <div style={styles.geoEmptyState}>
        Noch keine oeffentlichen Ziele mit Geolokation erkannt. Private Hosts bleiben im lokalen Netz sichtbar, externe Ziele erscheinen hier automatisch mit Kartenposition.
      </div>
    )
  }

  return (
    <svg viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="Geographische Flusskarte" style={styles.graphSvg}>
      <defs>
        <linearGradient id="geoFlowGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#7dd3fc" />
          <stop offset="100%" stopColor="#22c55e" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width={layout.width} height={layout.height} rx="18" fill="#07101d" />
      <rect x="22" y="20" width="148" height={layout.height - 40} rx="14" fill="#0f172a" stroke="#1e293b" />
      <text x="40" y="44" fill="#cbd5e1" fontSize="13" fontWeight="700">Lokales Netz</text>
      <text x="220" y="26" fill="#94a3b8" fontSize="12">Weltweite Ziele</text>
      {Array.from({ length: 6 }).map((_, index) => (
        <line
          key={`lat-${index}`}
          x1="220"
          y1={36 + index * ((layout.height - 72) / 5)}
          x2={layout.width - 28}
          y2={36 + index * ((layout.height - 72) / 5)}
          stroke="#163047"
          strokeWidth="1"
          opacity="0.7"
        />
      ))}
      {Array.from({ length: 7 }).map((_, index) => (
        <line
          key={`lon-${index}`}
          x1={220 + index * ((layout.width - 260) / 6)}
          y1="36"
          x2={220 + index * ((layout.width - 260) / 6)}
          y2={layout.height - 36}
          stroke="#12283b"
          strokeWidth="1"
          opacity="0.7"
        />
      ))}
      <g opacity="0.95">
        {GEO_MAP_POLYGONS.map(region => (
          <path
            key={region.id}
            d={buildGeoPolygonPath(region.points, layout.width, layout.height)}
            fill="#10263a"
            stroke="#22435c"
            strokeWidth="1.2"
            opacity="0.78"
          />
        ))}
      </g>
      {geoEdges.map((edge, index) => {
        const sourcePosition = layout.positions.get(edge.source)
        const targetPosition = layout.positions.get(edge.target)
        if (!sourcePosition || !targetPosition) return null
        const active = isEdgeActive(edge, index)
        const controlX = (sourcePosition.x + targetPosition.x) / 2
        const controlY = Math.min(sourcePosition.y, targetPosition.y) - Math.abs(targetPosition.x - sourcePosition.x) * 0.08 - 12

        return (
          <g key={`geo-${edgeKey(edge, index)}`} onClick={() => onEdgeFocus(edgeKey(edge, index))} style={{ cursor: 'pointer' }}>
            <title>{`${edge.source} nach ${edge.target}`}</title>
            <path
              d={`M ${sourcePosition.x} ${sourcePosition.y} Q ${controlX} ${controlY} ${targetPosition.x} ${targetPosition.y}`}
              fill="none"
              stroke="url(#geoFlowGradient)"
              strokeWidth={Math.max(2, Math.min(6, 1 + edge.connections))}
              opacity={active ? 0.92 : 0.18}
              strokeLinecap="round"
            />
          </g>
        )
      })}
      {localNodes.map(node => {
        const position = layout.positions.get(node.id)
        if (!position) return null
        const active = isNodeActive(node.id)
        return (
          <g key={`local-${node.id}`} onClick={() => onNodeFocus(node.id)} style={{ cursor: 'pointer' }}>
            <title>{node.label}</title>
            <rect x={position.x - 52} y={position.y - 16} width="104" height="32" rx="16" fill="#123047" stroke={active ? '#bae6fd' : '#334155'} strokeWidth={active ? '2.5' : '1.5'} opacity={active ? 1 : 0.65} />
            <text x={position.x} y={position.y + 5} textAnchor="middle" fill="#e0f2fe" fontSize="12" fontWeight="700">{node.label}</text>
          </g>
        )
      })}
      {geoNodes.map(node => {
        const position = layout.positions.get(node.id)
        if (!position) return null
        const active = isNodeActive(node.id)
        return (
          <g key={`geo-node-${node.id}`} onClick={() => onNodeFocus(node.id)} style={{ cursor: 'pointer' }}>
            <title>{`${node.label}: ${formatGeoLocation(node.geo)}`}</title>
            <circle cx={position.x} cy={position.y} r="10" fill="#22c55e" stroke={active ? '#f8fafc' : '#082f49'} strokeWidth={active ? '3' : '2'} opacity={active ? 1 : 0.8} />
            <text x={position.x} y={position.y + 24} textAnchor="middle" fill="#e2e8f0" fontSize="12" fontWeight="700">{node.label}</text>
            <text x={position.x} y={position.y + 38} textAnchor="middle" fill="#94a3b8" fontSize="10">{node.geo.country_code ?? node.geo.country ?? node.geo.resolved_ip}</text>
          </g>
        )
      })}
      {geoNodes.slice(0, 6).map((node, index) => {
        const label = `${node.label}: ${formatGeoLocation(node.geo)}`
        return <text key={`legend-${node.id}`} x="228" y={layout.height - 16 - index * 14} fill="#94a3b8" fontSize="10">{label}</text>
      })}
      <text x={layout.width - 132} y="24" fill="#64748b" fontSize="10">Laengengrad / Breitengrad</text>
    </svg>
  )
}

function GraphCanvas({
  nodes,
  edges,
  focus,
  onNodeFocus,
  onEdgeFocus,
}: {
  nodes: NetworkMapNode[]
  edges: NetworkMapEdge[]
  focus: FocusState
  onNodeFocus: (nodeId: string) => void
  onEdgeFocus: (key: string) => void
}) {
  const { width, height, positions } = useMemo(() => buildNodePositions(nodes), [nodes])
  const selectedEdge = focus?.type === 'edge' ? edges.find((edge, index) => edgeKey(edge, index) === focus.edgeKey) : null

  function isEdgeActive(edge: NetworkMapEdge, index: number) {
    if (!focus) return true
    if (focus.type === 'edge') return edgeKey(edge, index) === focus.edgeKey
    return edge.source === focus.nodeId || edge.target === focus.nodeId
  }

  function isNodeActive(nodeId: string) {
    if (!focus) return true
    if (focus.type === 'node') return nodeId === focus.nodeId || edges.some(edge => (edge.source === focus.nodeId || edge.target === focus.nodeId) && (edge.source === nodeId || edge.target === nodeId))
    return selectedEdge?.source === nodeId || selectedEdge?.target === nodeId
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Netzwerk Topologie" style={styles.graphSvg}>
      <defs>
        <linearGradient id="edgeGlow" x1="0%" x2="100%">
          <stop offset="0%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#22c55e" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width={width} height={height} rx="18" fill="#08111f" />
      {edges.map((edge, index) => {
        const source = positions.get(edge.source)
        const target = positions.get(edge.target)
        if (!source || !target) return null
        const active = isEdgeActive(edge, index)

        return (
          <g key={edgeKey(edge, index)} onClick={() => onEdgeFocus(edgeKey(edge, index))} style={{ cursor: 'pointer' }}>
            <title>{`${edge.source} nach ${edge.target}`}</title>
            <line
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              stroke="url(#edgeGlow)"
              strokeWidth={Math.max(2, Math.min(7, 1 + edge.connections))}
              opacity={active ? 0.95 : 0.18}
            />
          </g>
        )
      })}
      {nodes.map(node => {
        const point = positions.get(node.id)
        if (!point) return null
        const active = isNodeActive(node.id)

        return (
          <g key={node.id} onClick={() => onNodeFocus(node.id)} style={{ cursor: 'pointer' }}>
            <title>{node.label}</title>
            <circle cx={point.x} cy={point.y} r="26" fill={node.kind === 'external' ? '#1d4ed8' : '#0f766e'} stroke={active ? '#f8fafc' : '#64748b'} strokeWidth={active ? '3' : '2'} opacity={active ? 1 : 0.35} />
            <text x={point.x} y={point.y + 44} textAnchor="middle" fill="#e2e8f0" fontSize="14" fontWeight="700">
              {node.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export default function NetworkPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const { attachContext } = useAIChat()
  const selectedApp = searchParams.get('app')?.trim() || 'all'
  const selectedProtocol = searchParams.get('protocol')?.trim() || 'all'
  const selectedWindowHours = parseNetworkWindowHours(searchParams.get('window'))
  const [detailView, setDetailView] = useState<DetailView>(null)
  const [liveConnectionState, setLiveConnectionState] = useState<'verbindet' | 'verbunden' | 'unterbrochen'>('verbindet')
  const [liveSamples, setLiveSamples] = useState<LiveTrafficSample[]>([])
  const [pendingGraphSamples, setPendingGraphSamples] = useState<LiveTrafficSample[]>([])
  const [lastLiveEventAt, setLastLiveEventAt] = useState<string | null>(null)
  const [liveTick, setLiveTick] = useState(0)
  const activeTimeRange = buildNetworkTimeRange(selectedWindowHours)
  const { data, isLoading, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['network-map', selectedWindowHours],
    queryFn: () => getNetworkMap(buildNetworkTimeRange(selectedWindowHours)),
    refetchInterval: 15_000,
  })

  useEffect(() => {
    setPendingGraphSamples([])
  }, [dataUpdatedAt])

  useEffect(() => {
    const token = getStoredToken()
    const url = `${getApiBase()}/events/stream?event_type=network_flow&token=${encodeURIComponent(token ?? '')}`
    const eventSource = new EventSource(url)

    setLiveConnectionState('verbindet')

    eventSource.onopen = () => setLiveConnectionState('verbunden')
    eventSource.onmessage = event => {
      try {
        const payload = JSON.parse(event.data) as StreamedEvent
        const liveSample = inferLiveTrafficSample(payload)
        setLastLiveEventAt(liveSample?.timestamp ?? payload.timestamp ?? payload.created_at ?? new Date().toISOString())
        if (!liveSample) return

        setLiveSamples(previous => [liveSample, ...previous].slice(0, 24))
        setPendingGraphSamples(previous => [liveSample, ...previous].slice(0, 48))
      } catch {
        // Ignore malformed stream payloads and keep the live stream running.
      }
    }
    eventSource.onerror = () => {
      setLiveConnectionState('unterbrochen')
    }

    return () => {
      eventSource.close()
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setLiveTick(value => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const liveGraph = useMemo(
    () => applyLiveSamplesToGraph(data, pendingGraphSamples),
    [data, pendingGraphSamples],
  )
  const rawNodes = liveGraph.nodes
  const rawEdges = liveGraph.edges
  const appOptions = useMemo(() => uniqueEdgeValues(rawEdges, edge => edge.app), [rawEdges])
  const protocolOptions = useMemo(() => uniqueEdgeValues(rawEdges, edge => edge.protocol), [rawEdges])
  const edges = useMemo(
    () => rawEdges.filter(edge => {
      if (selectedApp !== 'all' && edge.app !== selectedApp) return false
      if (selectedProtocol !== 'all' && edge.protocol !== selectedProtocol) return false
      return true
    }),
    [rawEdges, selectedApp, selectedProtocol],
  )
  const nodes = useMemo(() => {
    const visibleNodeIds = new Set(edges.flatMap(edge => [edge.source, edge.target]))
    return rawNodes.filter(node => visibleNodeIds.has(node.id))
  }, [edges, rawNodes])
  const totalBytes = edges.reduce((sum, edge) => sum + edge.bytes, 0)
  const nodeLookup = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes])
  const nodeBreakdown = useMemo(
    () => [...nodes].sort((left, right) => right.total_bytes - left.total_bytes || right.total_connections - left.total_connections),
    [nodes],
  )
  const edgeBreakdown = useMemo(
    () => [...edges].sort((left, right) => right.connections - left.connections || right.bytes - left.bytes),
    [edges],
  )
  const volumeBreakdown = useMemo(() => {
    const byApp = new Map<string, { app: string; bytes: number; connections: number }>()
    for (const edge of edges) {
      const key = `${edge.app ?? 'unbekannt'}|${edge.protocol ?? 'n/a'}`
      const entry = byApp.get(key) ?? {
        app: `${edge.app ?? 'unbekannt'} (${edge.protocol ?? 'n/a'})`,
        bytes: 0,
        connections: 0,
      }
      entry.bytes += edge.bytes
      entry.connections += edge.connections
      byApp.set(key, entry)
    }
    return Array.from(byApp.values()).sort((left, right) => right.bytes - left.bytes || right.connections - left.connections)
  }, [edges])
  const geolocatedNodes = useMemo(() => nodeBreakdown.filter(hasGeo), [nodeBreakdown])
  const geolocatedCountries = useMemo(
    () => Array.from(new Set(geolocatedNodes.map(node => node.geo.country).filter(Boolean))).sort((left, right) => left!.localeCompare(right!)),
    [geolocatedNodes],
  )
  const geoEdges = useMemo(
    () => edgeBreakdown.filter(edge => hasGeo(nodeLookup.get(edge.source) as NetworkMapNode) || hasGeo(nodeLookup.get(edge.target) as NetworkMapNode)),
    [edgeBreakdown, nodeLookup],
  )
  const recentLiveSamples = useMemo(
    () => liveSamples.filter(sample => Date.parse(sample.timestamp) >= Date.now() - LIVE_WINDOW_MS),
    [liveSamples, liveTick],
  )
  const recentLiveBytes = useMemo(
    () => recentLiveSamples.reduce((sum, sample) => sum + sample.bytes, 0),
    [recentLiveSamples],
  )
  const focus = useMemo<FocusState>(() => {
    const focusedNodeId = searchParams.get('focus_node')
    if (focusedNodeId) return { type: 'node', nodeId: focusedNodeId }

    const focusedEdge = searchParams.get('focus_edge')
    if (!focusedEdge) return null

    const selectedIndex = edges.findIndex(edge => edgeFocusParam(edge) === focusedEdge)
    if (selectedIndex === -1) return null

    return { type: 'edge', edgeKey: edgeKey(edges[selectedIndex], selectedIndex) }
  }, [edges, searchParams])
  const topologyEdges = useMemo(() => {
    if (!focus) return edges
    if (focus.type === 'node') {
      return edges.filter(edge => edge.source === focus.nodeId || edge.target === focus.nodeId)
    }
    return edges.filter((edge, index) => edgeKey(edge, index) === focus.edgeKey)
  }, [edges, focus])
  const topologyNodes = useMemo(() => {
    if (!focus) return nodes

    const visibleNodeIds = new Set<string>()
    if (focus.type === 'node') visibleNodeIds.add(focus.nodeId)
    for (const edge of topologyEdges) {
      visibleNodeIds.add(edge.source)
      visibleNodeIds.add(edge.target)
    }
    return nodes.filter(node => visibleNodeIds.has(node.id))
  }, [focus, nodes, topologyEdges])

  function openAIContext(context: AIContextPayload) {
    attachContext(context)
    navigate('/ai')
  }

  function overviewContext(kind: Exclude<DetailView, null>): AIContextPayload {
    const base = {
      kind: `network_${kind}`,
      title: kind === 'nodes' ? 'Netzwerk-Knoten' : kind === 'edges' ? 'Netzwerk-Verbindungen' : 'Netzwerk-Gesamtvolumen',
      summary:
        kind === 'nodes'
          ? `Es gibt ${nodes.length} sichtbare Knoten. Die groessten Kandidaten sind ${nodeBreakdown.slice(0, 3).map(node => `${node.label} (${formatBytes(node.total_bytes)})`).join(', ')}.`
          : kind === 'edges'
            ? `Es gibt ${edges.length} sichtbare Verbindungen. Die aktivsten Pfade sind ${edgeBreakdown.slice(0, 3).map(edge => `${edge.source} -> ${edge.target} (${edge.connections} Verbindungen)`).join(', ')}.`
            : `Das aggregierte Volumen liegt bei ${formatBytes(totalBytes)}. Die staerksten Treiber sind ${volumeBreakdown.slice(0, 3).map(entry => `${entry.app} (${formatBytes(entry.bytes)})`).join(', ')}.`,
      prompt:
        kind === 'nodes'
          ? 'Bitte erklaere mir die wichtigsten Netzwerk-Knoten und was daran auffaellig ist.'
          : kind === 'edges'
            ? 'Bitte erklaere mir die wichtigsten Netzwerk-Verbindungen und was daran auffaellig ist.'
            : 'Bitte erklaere mir das Gesamtvolumen im Netzwerk und welche Kommunikationsmuster herausstechen.',
      details: {
        selected_app_filter: selectedApp,
        selected_protocol_filter: selectedProtocol,
        total_nodes: nodes.length,
        total_edges: edges.length,
        total_bytes: totalBytes,
        selected_time_window: formatNetworkWindowLabel(selectedWindowHours),
        geolocated_nodes: geolocatedNodes.slice(0, 8).map(node => ({
          label: node.label,
          location: formatGeoLocation(node.geo),
          latitude: node.geo.latitude,
          longitude: node.geo.longitude,
          resolved_ip: node.geo.resolved_ip,
        })),
        geolocated_countries: geolocatedCountries,
        geo_paths: geoEdges.slice(0, 8).map(edge => ({
          source: edge.source,
          target: edge.target,
          bytes: edge.bytes,
          connections: edge.connections,
        })),
        top_nodes: nodeBreakdown.slice(0, 8).map(node => ({
          id: node.id,
          label: node.label,
          kind: node.kind,
          total_bytes: node.total_bytes,
          total_connections: node.total_connections,
          geo: node.geo
            ? {
                location: formatGeoLocation(node.geo),
                latitude: node.geo.latitude,
                longitude: node.geo.longitude,
                resolved_ip: node.geo.resolved_ip,
              }
            : null,
        })),
        top_edges: edgeBreakdown.slice(0, 8).map(edge => ({
          source: edge.source,
          target: edge.target,
          app: edge.app,
          protocol: edge.protocol,
          dst_port: edge.dst_port,
          bytes: edge.bytes,
          connections: edge.connections,
        })),
        top_volume_groups: volumeBreakdown.slice(0, 8),
      },
    }
    return base
  }
  const focusSummary = useMemo(() => {
    if (!focus) return null

    if (focus.type === 'node') {
      const node = nodes.find(entry => entry.id === focus.nodeId)
      if (!node) return null
      const relatedEdges = edges.filter(edge => edge.source === focus.nodeId || edge.target === focus.nodeId)
      return {
        title: `Fokus: ${node.label}`,
        stats: [
          `${relatedEdges.length} ${relatedEdges.length === 1 ? 'verbundener Pfad' : 'verbundene Pfade'}`,
          `${formatBytes(relatedEdges.reduce((sum, edge) => sum + edge.bytes, 0))} ueber diesen Knoten`,
        ],
        eventsHref: buildDrilldownQuery({
          host: node.label,
        }),
      }
    }

    const selected = edges.find((edge, index) => edgeKey(edge, index) === focus.edgeKey)
    if (!selected) return null
    return {
      title: `Fokus: ${selected.source} → ${selected.target}`,
      stats: [
        `App: ${selected.app ?? 'unbekannt'}`,
        `Protokoll: ${selected.protocol ?? 'n/a'} / ${selected.dst_port ?? 'n/a'}`,
        `${formatBytes(selected.bytes)} ueber diesen Pfad`,
      ],
      eventsHref: buildDrilldownQuery({
        host: selected.source,
        service: selected.app ?? undefined,
        query: selected.target,
      }),
    }
  }, [edges, focus, nodes])

  const focusContext = useMemo<AIContextPayload | null>(() => {
    if (!focusSummary || !focus) return null
    return {
      kind: focus.type === 'node' ? 'network_focus_node' : 'network_focus_edge',
      title: focusSummary.title,
      summary: focusSummary.stats.join(' '),
      prompt:
        focus.type === 'node'
          ? 'Bitte analysiere den aktuell fokussierten Netzwerk-Knoten und erklaere seine Rolle.'
          : 'Bitte analysiere den aktuell fokussierten Netzwerk-Pfad und erklaere seine Bedeutung.',
      details: {
        focus,
        stats: focusSummary.stats,
        source_geo: focus.type === 'edge' && hasGeo(nodeLookup.get((focus as { type: 'edge'; edgeKey: string }).type === 'edge' ? edges.find((edge, index) => edgeKey(edge, index) === focus.edgeKey)?.source ?? '' : '') as NetworkMapNode)
          ? nodeLookup.get(edges.find((edge, index) => edgeKey(edge, index) === focus.edgeKey)?.source ?? '')?.geo
          : null,
        target_geo: focus.type === 'edge' && hasGeo(nodeLookup.get((focus as { type: 'edge'; edgeKey: string }).type === 'edge' ? edges.find((edge, index) => edgeKey(edge, index) === focus.edgeKey)?.target ?? '' : '') as NetworkMapNode)
          ? nodeLookup.get(edges.find((edge, index) => edgeKey(edge, index) === focus.edgeKey)?.target ?? '')?.geo
          : null,
        node_geo: focus.type === 'node' && hasGeo(nodeLookup.get(focus.nodeId) as NetworkMapNode) ? nodeLookup.get(focus.nodeId)?.geo : null,
      },
    }
  }, [edges, focus, focusSummary, nodeLookup])

  function updateSearchState(mutator: (params: URLSearchParams) => void) {
    setSearchParams(currentParams => {
      const nextParams = new URLSearchParams(currentParams)
      mutator(nextParams)
      return nextParams
    }, { replace: true })
  }

  function setFocusState(next: FocusState) {
    updateSearchState(nextParams => {
      nextParams.delete('focus_node')
      nextParams.delete('focus_edge')

      if (next?.type === 'node') {
        nextParams.set('focus_node', next.nodeId)
      } else if (next?.type === 'edge') {
        const selected = edges.find((edge, index) => edgeKey(edge, index) === next.edgeKey)
        if (selected) nextParams.set('focus_edge', edgeFocusParam(selected))
      }
    })
  }

  function setGraphFilterParam(key: 'app' | 'protocol', value: string) {
    updateSearchState(nextParams => {
      if (!value || value === 'all') nextParams.delete(key)
      else nextParams.set(key, value)
    })
  }

  function setNetworkWindow(hours: number) {
    updateSearchState(nextParams => {
      if (hours === DEFAULT_NETWORK_WINDOW_HOURS) nextParams.delete('window')
      else nextParams.set('window', String(hours))
    })
  }

  function toggleNodeFocus(nodeId: string) {
    setFocusState(focus?.type === 'node' && focus.nodeId === nodeId ? null : { type: 'node', nodeId })
  }

  function toggleEdgeFocus(key: string) {
    setFocusState(focus?.type === 'edge' && focus.edgeKey === key ? null : { type: 'edge', edgeKey: key })
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <div>
          <div style={styles.headingRow}>
            <h2 style={styles.h2}>Netzwerkfluesse</h2>
            <HelpTip content="Dieses Tab zeigt erkannte Kommunikationsbeziehungen zwischen internen Hosts, Diensten und externen Zielen. Klickbare KPI-Karten oeffnen die jeweilige Aufschluesselung." ariaLabel="Netzwerkfluesse erklaeren" />
          </div>
          <p style={styles.sub}>Kommunikationsbeziehungen zwischen Hosts, Services und Zielen im aktuellen Event-Bestand.</p>
        </div>
        <button type="button" onClick={() => openAIContext(overviewContext('edges'))} style={styles.aiExplainBtn}>
          Netzwerk im AI Chat analysieren
        </button>
      </div>

      <div style={styles.graphFilterBar}>
        <div style={styles.graphFilterFieldWide}>
          <span style={styles.graphFilterLabelRow}>
            <span style={styles.graphFilterLabel}>Zeitfenster</span>
            <HelpTip content="Begrenzt den Snapshot auf ein juengeres Zeitfenster. Kleinere Fenster laden schneller und zeigen Live-Aenderungen deutlicher, waehrend 'Alle' den gesamten Bestand einbezieht." ariaLabel="Netzwerk-Zeitfenster erklaeren" />
          </span>
          <div style={styles.timePresetRow}>
            {NETWORK_TIME_PRESETS.map(preset => (
              <button
                key={preset.hours}
                type="button"
                aria-label={`Zeitfenster ${preset.label}`}
                aria-pressed={selectedWindowHours === preset.hours}
                onClick={() => setNetworkWindow(preset.hours)}
                style={{
                  ...styles.timePresetBtn,
                  ...(selectedWindowHours === preset.hours ? styles.timePresetBtnActive : null),
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
        <label style={styles.graphFilterField}>
          <span style={styles.graphFilterLabelRow}>
            <span style={styles.graphFilterLabel}>App-Filter</span>
            <HelpTip content="Filtert die sichtbaren Pfade auf eine erkannte Anwendung. 'Alle Apps' zeigt den kompletten aktuellen Netzwerkgraphen." ariaLabel="App-Filter erklaeren" />
          </span>
          <select aria-label="App-Filter" value={selectedApp} onChange={event => setGraphFilterParam('app', event.target.value)} style={styles.graphFilterSelect}>
            <option value="all">Alle Apps</option>
            {appOptions.map(app => <option key={app} value={app}>{app}</option>)}
          </select>
        </label>
        <label style={styles.graphFilterField}>
          <span style={styles.graphFilterLabelRow}>
            <span style={styles.graphFilterLabel}>Protokoll-Filter</span>
            <HelpTip content="Filtert Pfade nach dem erkannten Netzwerkprotokoll. So kannst du zum Beispiel nur TCP- oder nur UDP-Kommunikation betrachten." ariaLabel="Protokoll-Filter erklaeren" />
          </span>
          <select aria-label="Protokoll-Filter" value={selectedProtocol} onChange={event => setGraphFilterParam('protocol', event.target.value)} style={styles.graphFilterSelect}>
            <option value="all">Alle Protokolle</option>
            {protocolOptions.map(protocol => <option key={protocol} value={protocol}>{protocol}</option>)}
          </select>
        </label>
        {(selectedApp !== 'all' || selectedProtocol !== 'all' || selectedWindowHours !== DEFAULT_NETWORK_WINDOW_HOURS) && (
          <button
            type="button"
            onClick={() => updateSearchState(nextParams => {
              nextParams.delete('app')
              nextParams.delete('protocol')
              nextParams.delete('window')
            })}
            style={styles.graphFilterReset}
          >
            Filter zuruecksetzen
          </button>
        )}
      </div>

      <div style={styles.livePanel}>
        <div style={styles.livePanelMain}>
          <div style={styles.panelTitleRow}>
            <div style={styles.panelTitleTight}>Live-Traffic</div>
            <HelpTip content="Der Netzwerktab lauscht auf neue Events und aktualisiert Snapshot, Volumen und Live-Liste automatisch. Die 60-Sekunden-Werte zeigen den juengsten beobachteten Netzwerkverkehr." ariaLabel="Live-Traffic erklaeren" />
          </div>
          <div style={styles.liveStatusRow}>
            <span style={{
              ...styles.liveStateBadge,
              ...(liveConnectionState === 'verbunden'
                ? styles.liveStateConnected
                : liveConnectionState === 'unterbrochen'
                  ? styles.liveStateDisconnected
                  : styles.liveStatePending),
            }}>
              {liveConnectionState === 'verbunden' ? 'Live verbunden' : liveConnectionState === 'unterbrochen' ? 'Live unterbrochen' : 'Live verbindet'}
            </span>
            <span style={styles.focusChip}>{recentLiveSamples.length} Updates / 60s</span>
            <span style={styles.focusChip}>{formatBytes(recentLiveBytes)} / 60s</span>
            <span style={styles.liveMeta}>Fenster: {formatNetworkWindowLabel(selectedWindowHours)} · Snapshot: {formatClock(dataUpdatedAt)} · Stream: {formatClock(lastLiveEventAt)}</span>
          </div>
        </div>
        <button type="button" onClick={() => void refetch()} style={styles.focusResetBtn}>Jetzt aktualisieren</button>
      </div>

      {recentLiveSamples.length > 0 ? (
        <div style={styles.liveFeed}>
          {recentLiveSamples.slice(0, 5).map(sample => (
            <div key={sample.id} style={styles.liveFeedRow}>
              <div>
                <div style={styles.rowTitle}>{sample.source} → {sample.target}</div>
                <div style={styles.rowMeta}>{sample.app} / {sample.protocol} · {formatClock(sample.timestamp)}</div>
              </div>
              <div style={styles.detailMetrics}>
                <span>{formatBytes(sample.bytes)}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={styles.liveEmptyState}>
          Noch keine Live-Netzwerkereignisse empfangen. Sobald neue Netzwerk-Events eintreffen, aktualisieren sich Volumen, Graph und Live-Liste automatisch.
        </div>
      )}

      <div style={styles.kpis}>
        <div style={{ ...styles.kpiCard, ...(detailView === 'nodes' ? styles.kpiCardActive : null) }}>
          <div style={styles.kpiTipRow}>
            <HelpTip content="Oeffnet eine sortierte Aufschluesselung aller sichtbaren Knoten inklusive Verbindungszahl und Volumen." ariaLabel="Knoten-Kennzahl erklaeren" />
          </div>
          <button type="button" onClick={() => setDetailView(value => value === 'nodes' ? null : 'nodes')} style={styles.kpiCardButton}>
            <span style={styles.kpiValue}><strong>{nodes.length} Knoten</strong></span>
            <span style={styles.kpiLabel}>Hosts und Ziele</span>
          </button>
        </div>
        <div style={{ ...styles.kpiCard, ...(detailView === 'edges' ? styles.kpiCardActive : null) }}>
          <div style={styles.kpiTipRow}>
            <HelpTip content="Oeffnet die detaillierte Uebersicht aller aggregierten Kommunikationspfade." ariaLabel="Verbindungen-Kennzahl erklaeren" />
          </div>
          <button type="button" onClick={() => setDetailView(value => value === 'edges' ? null : 'edges')} style={styles.kpiCardButton}>
            <span style={styles.kpiValue}><strong>{edges.length} {edges.length === 1 ? 'Verbindung' : 'Verbindungen'}</strong></span>
            <span style={styles.kpiLabel}>Aggregierte Kanten</span>
          </button>
        </div>
        <div style={{ ...styles.kpiCard, ...(detailView === 'volume' ? styles.kpiCardActive : null) }}>
          <div style={styles.kpiTipRow}>
            <HelpTip content="Oeffnet eine Volumen-Aufschluesselung nach erkannten Anwendungen und Protokollen." ariaLabel="Gesamtvolumen erklaeren" />
          </div>
          <button type="button" onClick={() => setDetailView(value => value === 'volume' ? null : 'volume')} style={styles.kpiCardButton}>
            <span style={styles.kpiValue}><strong>{formatBytes(totalBytes)}</strong></span>
            <span style={styles.kpiLabel}>Gesamtvolumen</span>
          </button>
        </div>
      </div>

      {detailView && (
        <div style={styles.detailPanel}>
          <div style={styles.detailPanelHeader}>
            <div>
              <div style={styles.detailTitleRow}>
                <div style={styles.focusTitle}>
                  {detailView === 'nodes' ? 'Aufschluesselung: Knoten' : detailView === 'edges' ? 'Aufschluesselung: Verbindungen' : 'Aufschluesselung: Gesamtvolumen'}
                </div>
                <HelpTip
                  content={detailView === 'nodes'
                    ? 'Sortierte Liste aller sichtbaren Knoten. Hohe Werte zeigen besonders zentrale oder stark belastete Kommunikationspartner.'
                    : detailView === 'edges'
                      ? 'Sortierte Liste aller sichtbaren Pfade. Hohe Verbindungszahlen deuten auf haeufige oder dauerhafte Kommunikation hin.'
                      : 'Zusammenfassung des beobachteten Datenvolumens nach Anwendung und Protokoll.'}
                  ariaLabel="Detailansicht erklaeren"
                />
              </div>
              <div style={styles.detailSub}>
                {detailView === 'nodes'
                  ? 'Die Liste ist nach uebertragenem Volumen und danach nach Verbindungszahl sortiert.'
                  : detailView === 'edges'
                    ? 'Die Liste ist nach Verbindungszahl und danach nach Volumen sortiert.'
                    : 'Die Liste gruppiert Volumen nach Anwendung und Protokoll.'}
              </div>
            </div>
            <div style={styles.detailActions}>
              <button type="button" onClick={() => openAIContext(overviewContext(detailView))} style={styles.aiExplainBtn}>
                Im AI Chat analysieren
              </button>
              <button type="button" onClick={() => setDetailView(null)} style={styles.focusResetBtn}>Schliessen</button>
            </div>
          </div>
          <div style={styles.detailList}>
            {detailView === 'nodes' && nodeBreakdown.map(node => (
              <div key={node.id} style={styles.detailRow}>
                <div>
                  <div style={styles.rowTitle}>{node.label}</div>
                  <div style={styles.rowMeta}>{node.kind}</div>
                </div>
                <div style={styles.detailMetrics}>
                  <span>{node.total_connections} Verbindungen</span>
                  <span>{formatBytes(node.total_bytes)}</span>
                </div>
              </div>
            ))}
            {detailView === 'edges' && edgeBreakdown.map((edge, index) => (
              <div key={edgeKey(edge, index)} style={styles.detailRow}>
                <div>
                  <div style={styles.rowTitle}>{edge.source} → {edge.target}</div>
                  <div style={styles.rowMeta}>{edge.app ?? 'unbekannte App'} / {edge.protocol ?? 'n/a'} / {edge.dst_port ?? 'n/a'}</div>
                </div>
                <div style={styles.detailMetrics}>
                  <span>{edge.connections} Verbindungen</span>
                  <span>{formatBytes(edge.bytes)}</span>
                </div>
              </div>
            ))}
            {detailView === 'volume' && volumeBreakdown.map(entry => (
              <div key={entry.app} style={styles.detailRow}>
                <div>
                  <div style={styles.rowTitle}>{entry.app}</div>
                  <div style={styles.rowMeta}>Aggregiert ueber alle sichtbaren Pfade</div>
                </div>
                <div style={styles.detailMetrics}>
                  <span>{entry.connections} Verbindungen</span>
                  <span>{formatBytes(entry.bytes)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {focusSummary && (
        <div style={styles.focusPanel}>
          <div>
            <div style={styles.focusTitle}>{focusSummary.title}</div>
            <div style={styles.focusStats}>
              {focusSummary.stats.map(stat => <span key={stat} style={styles.focusChip}>{stat}</span>)}
            </div>
          </div>
          <div style={styles.focusActions}>
            <Link to={focusSummary.eventsHref} style={styles.focusLink}>Events fuer Fokus</Link>
            {focusContext && (
              <button type="button" onClick={() => openAIContext(focusContext)} style={styles.aiExplainBtn}>
                Fokus im AI Chat
              </button>
            )}
            <button onClick={() => setFocusState(null)} style={styles.focusResetBtn}>Fokus aufheben</button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div style={styles.loading}>Netzwerkgraph wird geladen...</div>
      ) : !nodes.length || !edges.length ? (
        <div style={styles.emptyState}>Keine Netzwerkfluesse im aktuellen Filter gefunden.</div>
      ) : (
        <div style={styles.grid}>
          <section style={styles.panel}>
            <div style={styles.panelTitle}>Topologie</div>
            <GraphCanvas nodes={topologyNodes} edges={topologyEdges} focus={focus} onNodeFocus={toggleNodeFocus} onEdgeFocus={toggleEdgeFocus} />
          </section>

          <section style={{ ...styles.panel, gridColumn: '1 / -1' }}>
            <div style={styles.panelTitleRow}>
              <div style={styles.panelTitle}>Geographische Flusskarte</div>
              <HelpTip content="Oeffentliche IPs und aufloesbare Domains werden geolokalisiert. Private oder interne Hosts bleiben links als lokales Netz sichtbar, damit Herkunft und Ziel gemeinsam lesbar bleiben." ariaLabel="Geographische Flusskarte erklaeren" />
            </div>
            <div style={styles.geoSummaryRow}>
              <span style={styles.focusChip}>{geolocatedNodes.length} geolokalisierte Endpunkte</span>
              <span style={styles.focusChip}>{geolocatedCountries.length} erkannte Laender</span>
              <span style={styles.focusChip}>{geoEdges.length} Pfade mit Kartenbezug</span>
            </div>
            <GeoFlowMap nodes={nodes} edges={edges} focus={focus} onNodeFocus={toggleNodeFocus} onEdgeFocus={toggleEdgeFocus} />
            {geolocatedNodes.length > 0 && (
              <div style={styles.geoLocationList}>
                {geolocatedNodes.slice(0, 8).map(node => (
                  <div key={`geo-list-${node.id}`} style={styles.geoLocationCard}>
                    <div>
                      <div style={styles.rowTitle}>{node.label}</div>
                      <div style={styles.rowMeta}>{formatGeoLocation(node.geo)}</div>
                    </div>
                    <div style={styles.detailMetrics}>
                      <span>{formatBytes(node.total_bytes)}</span>
                      <span>{node.geo.resolved_ip ?? 'ohne IP-Anzeige'}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section style={styles.panel}>
            <div style={styles.panelTitle}>Knoten</div>
            <div style={styles.stack}>
              {nodes.map(node => (
                <div key={node.id} style={{ ...styles.listRow, ...(focus?.type === 'node' && focus.nodeId === node.id ? styles.focusedRow : null) }}>
                  <div style={styles.rowMain}>
                    <div style={styles.rowTitle}>{node.label}</div>
                    <div style={styles.rowMeta}>{node.kind}{hasGeo(node) ? ` · ${formatGeoLocation(node.geo)}` : ''}</div>
                  </div>
                  <div style={styles.rowStats}>
                    <div style={styles.metricGroup}>
                      <span>{formatBytes(node.total_bytes)}</span>
                      <span>{node.total_connections} Verbindungen</span>
                    </div>
                    <div style={styles.actionGroup}>
                      <button
                        type="button"
                        onClick={() => toggleNodeFocus(node.id)}
                        aria-label={`Knoten ${node.label} fokussieren`}
                        aria-pressed={focus?.type === 'node' && focus.nodeId === node.id}
                        style={styles.focusBtn}
                      >
                        Fokus
                      </button>
                      <Link
                        to={buildDrilldownQuery({
                          host: node.label,
                        })}
                        style={styles.detailLink}
                      >
                        Events zu {node.label}
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section style={{ ...styles.panel, gridColumn: '1 / -1' }}>
            <div style={styles.panelTitle}>Kommunikationspfade</div>
            <div style={styles.stack}>
              {edges.map((edge, index) => (
                <div key={edgeKey(edge, index)} style={{ ...styles.edgeRow, ...(focus?.type === 'edge' && focus.edgeKey === edgeKey(edge, index) ? styles.focusedRow : null) }}>
                  <div style={styles.rowMain}>
                    <div style={styles.rowTitle}>{edge.source} → {edge.target}</div>
                    <div style={styles.rowMeta}>{edge.app ?? 'unbekannte App'}</div>
                  </div>
                  <div style={styles.edgeMeta}>
                    <div style={styles.metricGroup}>
                      <span>{edge.protocol ?? 'n/a'} / {edge.dst_port ?? 'n/a'}</span>
                      <span>{edge.connections} {edge.connections === 1 ? 'Verbindung' : 'Verbindungen'}</span>
                      <span>{formatBytes(edge.bytes)}</span>
                    </div>
                    <div style={styles.actionGroup}>
                      <button
                        type="button"
                        onClick={() => toggleEdgeFocus(edgeKey(edge, index))}
                        aria-label={`Pfad ${edge.source} nach ${edge.target} fokussieren`}
                        aria-pressed={focus?.type === 'edge' && focus.edgeKey === edgeKey(edge, index)}
                        style={styles.focusBtn}
                      >
                        Fokus
                      </button>
                      <Link
                        to={buildDrilldownQuery({
                          host: edge.source,
                          service: edge.app ?? undefined,
                          query: edge.target,
                        })}
                        style={styles.detailLink}
                      >
                        Events {edge.source} nach {edge.target}
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: '1rem' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  headingRow: { display: 'flex', alignItems: 'center', gap: '0.55rem' },
  h2: { margin: 0, fontSize: '1.5rem' },
  sub: { margin: '0.4rem 0 0 0', color: '#94a3b8', maxWidth: 780 },
  aiExplainBtn: {
    background: '#0f2d46',
    color: '#bae6fd',
    border: '1px solid #38bdf8',
    borderRadius: 8,
    padding: '0.5rem 0.85rem',
    cursor: 'pointer',
    fontWeight: 700,
    whiteSpace: 'nowrap',
  },
  graphFilterBar: {
    display: 'flex',
    gap: '0.75rem',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    background: '#111827',
    border: '1px solid #1f2937',
    borderRadius: 12,
    padding: '0.75rem 0.9rem',
  },
  graphFilterFieldWide: { display: 'flex', flexDirection: 'column', gap: '0.35rem', minWidth: 240, flex: '1 1 280px' },
  graphFilterField: { display: 'flex', flexDirection: 'column', gap: '0.35rem', minWidth: 180 },
  graphFilterLabelRow: { display: 'flex', alignItems: 'center', gap: '0.4rem' },
  graphFilterLabel: { color: '#94a3b8', fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' },
  timePresetRow: { display: 'flex', gap: '0.45rem', flexWrap: 'wrap' },
  timePresetBtn: {
    background: '#0f172a',
    color: '#94a3b8',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: '#334155',
    borderRadius: 8,
    padding: '0.46rem 0.7rem',
    cursor: 'pointer',
    fontWeight: 700,
  },
  timePresetBtnActive: {
    background: '#3b82f6',
    color: '#fff',
    borderColor: '#3b82f6',
  },
  graphFilterSelect: {
    background: '#0f172a',
    color: '#e2e8f0',
    border: '1px solid #334155',
    borderRadius: 8,
    padding: '0.5rem 0.65rem',
  },
  graphFilterReset: {
    background: 'none',
    color: '#7dd3fc',
    border: '1px solid #38bdf8',
    borderRadius: 8,
    padding: '0.5rem 0.8rem',
    cursor: 'pointer',
    fontWeight: 700,
  },
  livePanel: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '1rem',
    flexWrap: 'wrap',
    background: '#111827',
    border: '1px solid #164e63',
    borderRadius: 12,
    padding: '0.9rem 1rem',
  },
  livePanelMain: { display: 'flex', flexDirection: 'column', gap: '0.45rem' },
  liveStatusRow: { display: 'flex', alignItems: 'center', gap: '0.55rem', flexWrap: 'wrap' },
  liveStateBadge: { borderRadius: 999, padding: '0.22rem 0.65rem', fontSize: '0.82rem', fontWeight: 700 },
  liveStateConnected: { background: '#0f3d2e', color: '#86efac' },
  liveStateDisconnected: { background: '#3f1212', color: '#fca5a5' },
  liveStatePending: { background: '#3b2505', color: '#fcd34d' },
  liveMeta: { color: '#94a3b8', fontSize: '0.8rem' },
  liveFeed: {
    display: 'grid',
    gap: '0.65rem',
    background: '#111827',
    border: '1px solid #1f2937',
    borderRadius: 12,
    padding: '0.8rem 0.9rem',
  },
  liveFeedRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '0.85rem',
    flexWrap: 'wrap',
    background: '#0f172a',
    border: '1px solid #1f2937',
    borderRadius: 10,
    padding: '0.75rem 0.85rem',
  },
  liveEmptyState: {
    background: '#111827',
    border: '1px dashed #334155',
    borderRadius: 12,
    padding: '0.95rem 1rem',
    color: '#94a3b8',
    fontSize: '0.86rem',
  },
  kpis: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' },
  kpiCard: {
    background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)', border: '1px solid #334155', borderRadius: 12,
    padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.35rem',
    textAlign: 'left',
    color: '#f8fafc',
  },
  kpiCardButton: {
    background: 'none',
    border: 'none',
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.35rem',
    textAlign: 'left',
    color: '#f8fafc',
    cursor: 'pointer',
    width: '100%',
  },
  kpiCardActive: {
    border: '1px solid #38bdf8',
    boxShadow: '0 0 0 1px rgba(56, 189, 248, 0.25) inset',
  },
  kpiTipRow: { display: 'flex', justifyContent: 'flex-end' },
  kpiTitleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.65rem' },
  kpiValue: { display: 'block' },
  kpiLabel: { color: '#94a3b8', fontSize: '0.82rem' },
  detailPanel: {
    background: '#111827',
    border: '1px solid #334155',
    borderRadius: 14,
    padding: '1rem',
  },
  detailPanelHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '1rem',
    marginBottom: '0.9rem',
    flexWrap: 'wrap',
  },
  detailTitleRow: { display: 'flex', alignItems: 'center', gap: '0.45rem' },
  detailSub: { color: '#94a3b8', fontSize: '0.84rem', marginTop: '0.25rem' },
  detailActions: { display: 'flex', gap: '0.65rem', flexWrap: 'wrap' },
  detailList: { display: 'grid', gap: '0.65rem' },
  detailRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '0.85rem',
    flexWrap: 'wrap',
    background: '#0f172a',
    border: '1px solid #1f2937',
    borderRadius: 10,
    padding: '0.8rem 0.9rem',
  },
  detailMetrics: { display: 'flex', gap: '0.75rem', flexWrap: 'wrap', color: '#cbd5e1', fontSize: '0.82rem' },
  focusPanel: {
    display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center', background: '#111827',
    border: '1px solid #164e63', borderRadius: 12, padding: '0.9rem 1rem',
  },
  focusActions: { display: 'flex', gap: '0.65rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' },
  focusTitle: { fontWeight: 700, fontSize: '1rem', color: '#e0f2fe' },
  focusStats: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.45rem' },
  focusChip: { background: '#0f2d46', color: '#bae6fd', borderRadius: 999, padding: '0.22rem 0.65rem', fontSize: '0.82rem' },
  focusLink: { color: '#082f49', background: '#7dd3fc', borderRadius: 8, padding: '0.45rem 0.8rem', fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' },
  focusResetBtn: { background: 'none', border: '1px solid #38bdf8', color: '#7dd3fc', borderRadius: 8, padding: '0.45rem 0.8rem', cursor: 'pointer', whiteSpace: 'nowrap' },
  loading: { color: '#94a3b8', padding: '2rem 0' },
  emptyState: {
    background: '#111827', border: '1px dashed #334155', borderRadius: 12, padding: '2rem', textAlign: 'center', color: '#94a3b8',
  },
  grid: { display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(320px, 1fr)', gap: '1rem' },
  panel: { background: '#1e293b', border: '1px solid #334155', borderRadius: 14, padding: '1rem' },
  panelTitleRow: { display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' },
  panelTitle: { fontSize: '0.86rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#94a3b8', marginBottom: '0.75rem' },
  panelTitleTight: { fontSize: '0.86rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#94a3b8' },
  graphSvg: { width: '100%', height: '360px', display: 'block' },
  geoSummaryRow: { display: 'flex', gap: '0.55rem', flexWrap: 'wrap', marginBottom: '0.8rem' },
  geoEmptyState: {
    background: '#08111f',
    border: '1px dashed #334155',
    borderRadius: 12,
    padding: '1.2rem',
    color: '#94a3b8',
    fontSize: '0.88rem',
  },
  geoLocationList: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.65rem', marginTop: '0.8rem' },
  geoLocationCard: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '0.85rem',
    flexWrap: 'wrap',
    background: '#0f172a',
    border: '1px solid #1f2937',
    borderRadius: 10,
    padding: '0.75rem 0.85rem',
  },
  stack: { display: 'flex', flexDirection: 'column', gap: '0.65rem' },
  listRow: {
    display: 'flex', justifyContent: 'space-between', gap: '0.9rem', flexWrap: 'wrap', background: '#0f172a', border: '1px solid #1f2937', borderRadius: 10, padding: '0.8rem 0.9rem',
  },
  focusedRow: { border: '1px solid #38bdf8', boxShadow: '0 0 0 1px rgba(56, 189, 248, 0.25) inset' },
  edgeRow: {
    display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', background: '#0f172a', border: '1px solid #1f2937', borderRadius: 10, padding: '0.85rem 0.95rem', alignItems: 'center',
  },
  rowMain: { flex: '1 1 240px', minWidth: 0 },
  rowTitle: { fontWeight: 700, overflowWrap: 'anywhere' },
  rowMeta: { color: '#94a3b8', fontSize: '0.82rem', marginTop: '0.2rem' },
  rowStats: { display: 'flex', flex: '1 1 260px', minWidth: 0, gap: '0.65rem', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', color: '#cbd5e1', fontSize: '0.82rem' },
  edgeMeta: { display: 'flex', flex: '1 1 320px', minWidth: 0, gap: '0.65rem', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', color: '#cbd5e1', fontSize: '0.82rem' },
  metricGroup: { display: 'flex', gap: '0.65rem', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', minWidth: 0 },
  actionGroup: { display: 'flex', gap: '0.65rem', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', minWidth: 0 },
  focusBtn: { background: '#164e63', color: '#cffafe', border: '1px solid #0891b2', borderRadius: 8, padding: '0.35rem 0.65rem', cursor: 'pointer', fontWeight: 700 },
  detailLink: { color: '#7dd3fc', textDecoration: 'none', fontWeight: 700, overflowWrap: 'anywhere', textAlign: 'right' },
}