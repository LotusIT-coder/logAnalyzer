import { useSourceFilter } from '../ctx/useSourceFilter'

export default function GlobalSourceFilterNotice({
  marginBottom = '0.75rem',
  showClear = true,
}: {
  marginBottom?: string
  showClear?: boolean
}) {
  const { filter, hasFilter, clearFilter } = useSourceFilter()

  if (!hasFilter) return null

  const pathNames = filter.sourcePaths.map(p => p.split('/').pop() ?? p)
  const idLabels = filter.sourceIds.map(id => `ID:${id.slice(0, 8)}`)
  const labels = [...pathNames, ...idLabels]

  return (
    <div style={{
      background: '#10223f', border: '1px solid #1e3a8a', color: '#bfdbfe',
      borderRadius: 8, padding: '0.45rem 0.7rem', marginBottom, fontSize: '0.8rem',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem',
      flexWrap: 'wrap',
    }}>
      <span>
        Quellenfilter aktiv:{' '}
        {labels.map((name, i) => (
          <span key={i} style={{
            background: '#1e3a8a', borderRadius: 4, padding: '0.1rem 0.4rem',
            marginLeft: i === 0 ? '0.25rem' : '0.35rem', fontFamily: 'monospace',
          }}>{name}</span>
        ))}
      </span>
      {showClear && (
        <button
          onClick={clearFilter}
          style={{
            background: 'none', border: '1px solid #3b82f6', color: '#93c5fd',
            borderRadius: 6, padding: '0.18rem 0.55rem', cursor: 'pointer', fontSize: '0.75rem',
          }}
        >
          Filter zurücksetzen
        </button>
      )}
    </div>
  )
}
